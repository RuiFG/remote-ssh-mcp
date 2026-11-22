import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { randomUUID, createHash } from "node:crypto";
import { lock } from "proper-lockfile";
import { z } from "zod";
import { StoredHost, Serial, SshError, type HostProfile } from "./domain.ts";

export async function readJson(file: string): Promise<unknown | undefined> {
  try { return JSON.parse(await readFile(file, "utf8")); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; }
}
export async function atomicJson(file: string, value: unknown) {
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const temp = `${file}.${randomUUID()}.tmp`;
  try {
    await writeFile(temp, JSON.stringify(value, null, 2) + "\n", { mode: 0o600, flag: "wx" });
    await rename(temp, file);
  } finally { await rm(temp, { force: true }); }
}
export async function locked<T>(file: string, operation: () => Promise<T>): Promise<T> {
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const release = await lock(file, { realpath: false, retries: { retries: 20, minTimeout: 25, maxTimeout: 250 } });
  try { return await operation(); } finally { await release(); }
}
export class Profiles {
  private hosts: HostProfile[] = [];
  constructor(private readonly file: string) {}
  async load() { this.hosts = z.array(StoredHost).parse(await readJson(this.file) ?? []); }
  list(): HostProfile[] { return structuredClone(this.hosts); }
  get(selector: string): HostProfile {
    const host = this.hosts.find(h => h.id === selector);
    if (!host) throw new SshError("HOST_NOT_FOUND", `Unknown SSH host: ${selector}`);
    return structuredClone(host);
  }
  chain(selector: string): HostProfile[] {
    const chain: HostProfile[] = [], seen = new Set<string>();
    let host: HostProfile | undefined = this.get(selector);
    while (host) {
      if (seen.has(host.id)) throw new SshError("JUMP_CYCLE", "ProxyJump chain contains a cycle");
      if (chain.length >= 16) throw new SshError("JUMP_LIMIT", "ProxyJump supports at most 16 hops");
      seen.add(host.id); chain.unshift(host);
      host = host.jumpHostId ? this.get(host.jumpHostId) : undefined;
    }
    return chain;
  }
  /** Caller holds the registry lock across validation, credential changes and commit. */
  async commit(hosts: HostProfile[]) {
    const next = z.array(StoredHost).parse(hosts);
    const candidate = new Profiles(this.file);
    candidate.hosts = next;
    {
      const names = new Set<string>(), ids = new Set<string>();
      for (const host of next) {
        if (names.has(host.name.toLowerCase()) || ids.has(host.id)) throw new SshError("NAME_EXISTS", "Host names and IDs must be unique");
        names.add(host.name.toLowerCase()); ids.add(host.id); candidate.chain(host.id);
      }
      await atomicJson(this.file, next);
      this.hosts = next;
    }
  }

}
const Pins = z.record(z.string(), z.object({ fingerprint: z.string(), firstSeen: z.string() }));
export class HostKeys {
  private pins: z.infer<typeof Pins> = {};
  private serial = new Serial();
  constructor(private readonly file: string) {}
  async load() { this.pins = Pins.parse(await readJson(this.file) ?? {}); }
  async verify(host: Pick<HostProfile, "hostname" | "port">, key: Buffer) {
    return this.serial.run(() => locked(this.file, async () => {
      await this.load();
      const address = JSON.stringify([host.hostname.toLowerCase(), host.port]);
      const fingerprint = `SHA256:${createHash("sha256").update(key).digest("base64").replace(/=+$/, "")}`;
      const pin = this.pins[address];
      if (pin && pin.fingerprint !== fingerprint) throw new SshError("HOST_KEY_CHANGED", `Server identity changed for ${host.hostname}:${host.port}`, { expected: pin.fingerprint, received: fingerprint });
      if (!pin) {
        const next = { ...this.pins, [address]: { fingerprint, firstSeen: new Date().toISOString() } };
        await atomicJson(this.file, next); this.pins = next;
      }
      return fingerprint;
    }));
  }
  async forget(host: Pick<HostProfile, "hostname" | "port">) {
    await this.serial.run(() => locked(this.file, async () => {
      await this.load();
      const next = { ...this.pins };
      delete next[JSON.stringify([host.hostname.toLowerCase(), host.port])];
      await atomicJson(this.file, next); this.pins = next;
    }));
  }
}
