import path from "node:path";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { Profiles, HostKeys, atomicJson, readJson, locked } from "./storage.ts";
import { EncryptedFileSecrets, type SecretBackend } from "./credentials.ts";
import { HostInput, Serial, SshError, type HostDraft, type HostProfile } from "./domain.ts";
import { localPath } from "./paths.ts";
import { sudoIdentity } from "./sudo.ts";

type Temporary = { identity: string; value: string };
export type CredentialInput = { kind: "login" | "sudo"; credential?: string; reuseSshPassword?: boolean; remember?: boolean };
export type HostPatch = Partial<Omit<HostDraft, "id" | "privateKeyPath" | "jumpHostId">> & { privateKeyPath?: string | null; jumpHostId?: string | null };

export function publicHost(host: HostProfile) {
  const { credentialId, sudoCredentialId, sudoIdentity: _identity, remembered: _remembered, revision: _revision, ...profile } = host;
  return { ...profile, loginCredentialSaved: !!credentialId, sudoCredentialSaved: !!sudoCredentialId };
}

/** One lock covers host versions, credential references and garbage collection.
 * Secret bytes are staged first; all live references commit in one hosts.json rename.
 */
export class Registry {
  readonly profiles: Profiles;
  readonly keys: HostKeys;
  private readonly secrets: SecretBackend;
  private readonly serial = new Serial();
  private readonly lockFile: string;
  private readonly cleanupFile: string;
  private readonly login = new Map<string, Temporary>();
  private readonly sudo = new Map<string, Temporary>();
  private closed = false;

  constructor(directory: string, secrets?: SecretBackend) {
    this.profiles = new Profiles(path.join(directory, "hosts.json"));
    this.keys = new HostKeys(path.join(directory, "known-hosts.json"));
    this.secrets = secrets ?? new EncryptedFileSecrets(path.join(directory, "credentials"));
    this.lockFile = path.join(directory, "registry");
    this.cleanupFile = path.join(directory, "pending-cleanup.json");
  }
  async load() { await this.profiles.load(); }
  close() { this.closed = true; this.login.clear(); this.sudo.clear(); }
  private assertOpen() { if (this.closed) throw new SshError("SESSION_CLOSED", "MCP connection closed"); }
  private check(id: string, expectedVersion: number) {
    const host = this.profiles.get(id);
    if (host.version !== expectedVersion) throw new SshError("HOST_CONFLICT", "Host changed; list hosts and use its current version", { hostId: id, currentVersion: host.version });
    return host;
  }
  private async queue(ids: (string | undefined)[]) {
    const current = z.array(z.string().uuid()).parse(await readJson(this.cleanupFile) ?? []);
    await atomicJson(this.cleanupFile, [...new Set([...current, ...ids.filter((v): v is string => !!v)])]);
  }
  /** A staged ID may already be committed after a crash: never delete a live reference. */
  private async collect(): Promise<boolean> {
    try {
      const pending = z.array(z.string().uuid()).parse(await readJson(this.cleanupFile) ?? []);
      if (!pending.length) return false;
      const live = new Set(this.profiles.list().flatMap(h => [h.credentialId, h.sudoCredentialId]).filter(Boolean));
      const failed: string[] = [];
      for (const id of pending) {
        if (live.has(id)) continue;
        try { await this.secrets.delete(id); } catch { failed.push(id); }
      }
      await atomicJson(this.cleanupFile, failed);
      return failed.length > 0;
    } catch { return true; }
  }
  private async stage(value: string) {
    const id = randomUUID();
    await this.queue([id]);
    await this.secrets.set(id, value);
    return id;
  }
  private async write<T extends object>(operation: () => Promise<T>): Promise<T & { cleanupPending: boolean }> {
    return this.serial.run(() => locked(this.lockFile, async () => {
      this.assertOpen(); await this.profiles.load();
      await this.collect();
      try {
        const value = await operation();
        return { ...value, cleanupPending: await this.collect() };
      } catch (error) { await this.collect(); throw error; }
    }));
  }
  private loginIdentity(host: HostProfile) { return `${host.id}:${host.revision}`; }
  async loginSecret(host: HostProfile) {
    this.assertOpen();
    const temporary = this.login.get(host.id);
    if (temporary?.identity === this.loginIdentity(host)) return temporary.value;
    return host.credentialId ? this.secrets.get(host.credentialId) : undefined;
  }
  async sudoSecret(host: HostProfile, identity: string) {
    this.assertOpen();
    const temporary = this.sudo.get(host.id);
    if (temporary?.identity === identity) return temporary.value;
    return host.sudoCredentialId && host.sudoIdentity === identity ? this.secrets.get(host.sudoCredentialId) : undefined;
  }
  private normalized(draft: HostDraft) {
    const value = HostInput.parse(draft);
    if (value.privateKeyPath) value.privateKeyPath = localPath(value.privateKeyPath);
    return value;
  }
  private replace(host: HostProfile) { return this.profiles.commit([...this.profiles.list().filter(h => h.id !== host.id), host]); }
  async add(draft: HostDraft, credential?: string, remember = true) {
    return this.write(async () => {
      const input = this.normalized(draft);
      if (input.id) throw new SshError("INVALID_ARGUMENT", "New host IDs are generated by the server");
      const host: HostProfile = { ...input, id: randomUUID(), version: 1, revision: 1, remembered: false };
      if (credential !== undefined && remember) { host.credentialId = await this.stage(credential); host.remembered = true; }
      await this.replace(host);
      if (credential !== undefined && !remember && !this.closed) this.login.set(host.id, { identity: this.loginIdentity(host), value: credential });
      return { host: publicHost(host) };
    });
  }
  async update(id: string, expectedVersion: number, patch: HostPatch) {
    return this.write(async () => {
      const old = this.check(id, expectedVersion);
      const { version: _version, revision: _revision, credentialId: _credential, sudoCredentialId: _sudo, sudoIdentity: _identity, remembered: _remembered, ...draft } = old;
      const input = this.normalized({ ...draft, ...patch, privateKeyPath: patch.privateKeyPath === null ? undefined : patch.privateKeyPath ?? old.privateKeyPath, jumpHostId: patch.jumpHostId === null ? undefined : patch.jumpHostId ?? old.jumpHostId });
      const host = { ...old, ...input, version: old.version + 1 };
      const identity = (h: HostProfile) => JSON.stringify([h.hostname, h.port, h.username, h.auth, h.privateKeyPath, h.jumpHostId]);
      if (identity(old) !== identity(host)) {
        await this.queue([old.credentialId, old.sudoCredentialId]);
        host.revision++; host.credentialId = undefined; host.remembered = false;
        host.sudoCredentialId = undefined; host.sudoIdentity = undefined;
      }
      await this.replace(host);
      return { host: publicHost(host) };
    });
  }
  async setCredential(id: string, expectedVersion: number, input: CredentialInput) {
    return this.write(async () => {
      const host = this.check(id, expectedVersion);
      let value = input.credential;
      if (input.reuseSshPassword) {
        if (input.kind !== "sudo" || value !== undefined || host.auth !== "password") throw new SshError("INVALID_ARGUMENT", "SSH password reuse requires sudo, password login and no supplied credential");
        value = await this.loginSecret(host);
      }
      if (value === undefined) throw new SshError("CREDENTIAL_REQUIRED", "Provide a credential or an available SSH password for explicit reuse");
      if (input.kind === "sudo" && /[\r\n\0]/.test(value)) throw new SshError("INVALID_CREDENTIAL", "Sudo passwords cannot contain newline or NUL");
      const identity = input.kind === "login" ? this.loginIdentity(host) : sudoIdentity(this.profiles.chain(id));
      if (input.remember === false) {
        (input.kind === "login" ? this.login : this.sudo).set(id, { identity, value });
        return { host: publicHost(host), remembered: false };
      }
      const credentialId = await this.stage(value);
      const next = { ...host, version: host.version + 1 };
      if (input.kind === "login") {
        await this.queue([host.credentialId]);
        next.credentialId = credentialId; next.remembered = true; next.revision++;
      } else {
        await this.queue([host.sudoCredentialId]);
        next.sudoCredentialId = credentialId; next.sudoIdentity = identity;
      }
      await this.replace(next);
      (input.kind === "login" ? this.login : this.sudo).delete(id);
      return { host: publicHost(next), remembered: true };
    });
  }
  async remove(id: string, expectedVersion: number) {
    return this.write(async () => {
      const host = this.check(id, expectedVersion);
      if (this.profiles.list().some(h => h.jumpHostId === id)) throw new SshError("HOST_IN_USE", "Another host references this jump host");
      await this.queue([host.credentialId, host.sudoCredentialId]);
      await this.profiles.commit(this.profiles.list().filter(h => h.id !== id));
      this.login.delete(id); this.sudo.delete(id);
      return { hostId: id, deleted: true };
    });
  }
  async forgetKey(id: string, expectedVersion: number) {
    return this.write(async () => {
      const host = this.check(id, expectedVersion);
      await this.keys.forget(host);
      return { hostId: id, forgotten: true };
    });
  }
}
