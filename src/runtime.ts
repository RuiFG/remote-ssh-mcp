import { randomUUID } from "node:crypto";
import { Registry } from "./registry.ts";
import type { SecretBackend } from "./credentials.ts";
import { Connector, type Connection, type ExecOptions } from "./transport.ts";
import { Serial, SshError, checkAbort, type HostProfile, type HostStatus } from "./domain.ts";
import { remotePath } from "./paths.ts";
import { sudoIdentity } from "./sudo.ts";

type Slot = { chain: HostProfile[]; connection?: Connection; pending?: Promise<Connection>; controller: AbortController; status: HostStatus["status"]; error?: string; invalidated?: boolean };
type SessionState = { directories: Map<string, string>; blocked: Set<string>; slots: Map<string, Slot>; hostLocks: Map<string, Serial> };

export class RemoteRuntime {
  readonly registry: Registry;
  readonly profiles;
  readonly keys;
  private readonly connector: Connector;
  private readonly sessions = new Map<string, SessionState>();
  private readonly active = new Map<string, number>();
  private closed = false;
  constructor(directory: string, secrets?: SecretBackend, connector?: Connector) {
    this.registry = new Registry(directory, secrets);
    this.profiles = this.registry.profiles; this.keys = this.registry.keys;
    this.connector = connector ?? new Connector(this.keys);
  }
  async load() { await this.registry.load(); }
  session(id: string) {
    if (this.closed) throw new SshError("SESSION_CLOSED", "MCP connection closed");
    let state = this.sessions.get(id);
    if (!state) { state = { directories: new Map(), blocked: new Set(), slots: new Map(), hostLocks: new Map() }; this.sessions.set(id, state); }
    return state;
  }
  resolve(id: string, hostId: string) {
    const state = this.session(id), host = this.profiles.get(hostId);
    if (host.id !== hostId) throw new SshError("HOST_NOT_FOUND", "Use the hostId returned by ssh_list_hosts");
    return { host, directory: state.directories.get(host.id) };
  }
  state(id: string): { hosts: HostStatus[] } {
    const state = this.session(id);
    return { hosts: this.profiles.list().map(host => {
      const slot = state.slots.get(host.id);
      const changed = !!slot && (!!slot.invalidated || slot.chain.some(snapshot => {
        try { return this.profiles.get(snapshot.id).revision !== snapshot.revision; } catch { return true; }
      }));
      return { host, status: slot?.status ?? "disconnected", directory: state.directories.get(host.id), home: slot?.connection?.home, changed, sftp: slot?.connection?.sftpAvailable, error: slot?.error };
    }) };
  }
  invalidateCredential(id: string) {
    for (const state of this.sessions.values()) for (const slot of state.slots.values()) {
      if (slot.chain.some(h => h.id === id)) slot.invalidated = true;
    }
  }
  async operation<T>(hostId: string, action: () => Promise<T>) {
    this.active.set(hostId, (this.active.get(hostId) ?? 0) + 1);
    try { return await action(); }
    finally {
      const count = (this.active.get(hostId) ?? 1) - 1;
      if (count) this.active.set(hostId, count); else this.active.delete(hostId);
      // Cleanup cannot replace a command outcome after it has already executed.
      try { await this.profiles.load(); this.prune(); } catch {}
    }
  }
  prune() {
    const ids = new Set(this.profiles.list().map(h => h.id));
    for (const state of this.sessions.values()) for (const [id, slot] of state.slots) {
      if (!ids.has(id) && !this.active.has(id)) {
        slot.controller.abort(); slot.connection?.close(); state.slots.delete(id); state.directories.delete(id); state.hostLocks.delete(id);
      }
    }
  }
  private async secret(host: HostProfile, signal: AbortSignal, required = false) {
    checkAbort(signal);
    const value = await this.registry.loginSecret(host);
    checkAbort(signal);
    if (required && value === undefined) throw new SshError("CREDENTIAL_REQUIRED", "Use ssh_set_credentials to provide the login password or private key passphrase", { hostId: host.id });
    return value;
  }
  async execSudo(_sessionId: string, connection: Connection, command: string, options: ExecOptions) {
    const host = connection.chain.at(-1)!;
    const identity = sudoIdentity(connection.chain);
    return connection.exec(command, { ...options, sudo: async (signal, retry) => {
      checkAbort(signal);
      if (retry) throw new SshError("SUDO_AUTH_FAILED", "Sudo rejected the credential; update it with ssh_set_credentials before issuing a new command");
      await this.profiles.load();
      if (sudoIdentity(this.profiles.chain(host.id)) !== identity) throw new SshError("HOST_CHANGED", "Use ssh_reset_connection before sudo after configuration changes");
      const value = await this.registry.sudoSecret(this.profiles.get(host.id), identity);
      checkAbort(signal);
      if (value === undefined) throw new SshError("CREDENTIAL_REQUIRED", "Use ssh_set_credentials with kind:sudo, a credential or explicit reuseSshPassword:true", { hostId: host.id });
      return value;
    } });
  }
  async connection(id: string, hostId: string, explicit: boolean, signal?: AbortSignal): Promise<Connection> {
    const state = this.session(id);
    if (explicit) state.blocked.delete(hostId);
    if (state.blocked.has(hostId)) throw new SshError("MANUALLY_DISCONNECTED", "This host was explicitly disconnected; use ssh_set_workspace to reconnect");
    const previous = state.slots.get(hostId);
    if (previous?.connection?.alive) return previous.connection;
    if (previous?.pending) return previous.pending;
    const chain = this.profiles.chain(hostId);
    const controller = new AbortController();
    const combined = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
    const slot: Slot = { chain, controller, status: "connecting" };
    state.slots.set(hostId, slot);
    const pending = (async () => {
      let connection: Connection | undefined;
      try {
        connection = await this.connector.connect(chain, (host, required) => this.secret(host, combined, required), combined);
        checkAbort(combined);
        const priorDirectory = state.directories.get(hostId);
        if (priorDirectory) await connection.directory(priorDirectory, combined);
        else state.directories.set(hostId, connection.home);
        checkAbort(combined);
        slot.connection = connection; slot.status = "connected";
        connection.onClose(() => {
          if (state.slots.get(hostId) !== slot || state.blocked.has(hostId)) return;
          slot.status = "error"; slot.error = "Connection lost; the next operation can reconnect";
        });
        return connection;
      } catch (error) {
        connection?.close(); slot.status = "error";
        slot.error = error instanceof Error ? error.message : "Connection failed";
        throw error;
      } finally { slot.pending = undefined; }
    })();
    slot.pending = pending;
    return pending;
  }
  private hostLock(state: SessionState, hostId: string) {
    let lock = state.hostLocks.get(hostId);
    if (!lock) { lock = new Serial(); state.hostLocks.set(hostId, lock); }
    return lock;
  }
  async setWorkspace(id: string, hostId: string, directory: string | undefined, signal?: AbortSignal) {
    const state = this.session(id);
    return this.hostLock(state, hostId).run(async () => {
      const { host } = this.resolve(id, hostId);
      const connection = await this.connection(id, host.id, true, signal);
      const next = remotePath(directory, state.directories.get(host.id) ?? connection.home, connection.home);
      const resolved = await connection.directory(next, signal);
      checkAbort(signal);
      state.directories.set(host.id, resolved);
      return { hostId: host.id, hostName: host.name, directory: resolved };
    });
  }
  async disconnect(id: string, hostId: string) {
    const state = this.session(id);
    return this.hostLock(state, hostId).run(async () => {
      state.blocked.add(hostId);
      const slot = state.slots.get(hostId);
      slot?.controller.abort(); slot?.connection?.close();
      state.slots.delete(hostId); state.directories.delete(hostId);
    });
  }
  async reset(id: string, hostId: string, signal?: AbortSignal) {
    const state = this.session(id);
    if (state.blocked.has(hostId)) throw new SshError("MANUALLY_DISCONNECTED", "Use ssh_set_workspace to reconnect a manually disconnected host");
    const slot = state.slots.get(hostId);
    slot?.controller.abort(); slot?.connection?.close(); state.slots.delete(hostId);
    await this.connection(id, hostId, false, signal);
    return { hostId, directory: state.directories.get(hostId) };
  }
  async test(hostId: string, signal?: AbortSignal) {
    const id = `test:${randomUUID()}`;
    try {
      const connection = await this.connection(id, hostId, true, signal);
      return { home: connection.home, exec: true, sftp: connection.sftpAvailable, hops: connection.chain.map(host => host.name) };
    } finally { this.release(id); }
  }
  release(id: string) {
    const state = this.sessions.get(id);
    if (!state) return;
    for (const slot of state.slots.values()) { slot.controller.abort(); slot.connection?.close(); }
    this.sessions.delete(id);
  }
  close() {
    if (this.closed) return;
    for (const id of this.sessions.keys()) this.release(id);
    this.closed = true; this.registry.close();
  }
}
