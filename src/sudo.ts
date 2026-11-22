import { randomUUID, createHash } from "node:crypto";
import { quote } from "./paths.ts";
import { SshError, type HostProfile } from "./domain.ts";

export type SudoPassword = (signal: AbortSignal, retry: boolean) => Promise<string | undefined>;

/** One sudo process: authenticate before forwarding any command stdin, never replay. */
export class SudoExchange {
  private readonly prompt = `remote-ssh-sudo-${randomUUID()}`;
  private readonly ready = `remote-ssh-root-${randomUUID()}`;
  private pending = Buffer.alloc(0);
  private attempts = 0;
  authenticated = false;
  command(script: string) {
    return `sudo -S -p ${quote(this.prompt)} -u root -- sh -c ${quote(`printf '%s' ${quote(this.ready)} >&2\n${script}`)}`;
  }
  constructor(private readonly io: {
    password: SudoPassword; signal: AbortSignal;
    write: (value: string) => void; ready: () => void;
    output: (value: Buffer) => void; fail: (error: unknown) => void;
  }) {}
  push(data: Buffer) {
    if (this.authenticated) { this.io.output(data); return; }
    this.pending = Buffer.concat([this.pending, data]);
    while (this.pending.length) {
      const prompt = this.pending.indexOf(this.prompt), ready = this.pending.indexOf(this.ready);
      const index = prompt < 0 ? ready : ready < 0 ? prompt : Math.min(prompt, ready);
      if (index < 0) {
        const length = Math.max(0, this.pending.length - Math.max(this.prompt.length, this.ready.length) + 1);
        this.io.output(this.pending.subarray(0, length)); this.pending = this.pending.subarray(length);
        return;
      }
      this.io.output(this.pending.subarray(0, index));
      const isReady = index === ready;
      this.pending = this.pending.subarray(index + (isReady ? this.ready.length : this.prompt.length));
      if (isReady) {
        this.authenticated = true; this.io.ready(); this.flush(); return;
      }
      if (++this.attempts > 3) { this.io.fail(new SshError("SUDO_AUTH_FAILED", "Too many sudo password requests")); return; }
      void this.io.password(this.io.signal, this.attempts > 1).then(value => {
        if (this.io.signal.aborted) return;
        if (value === undefined) throw new SshError("CREDENTIAL_CANCELLED", "Sudo password input cancelled");
        if (/[\r\n\0]/.test(value)) throw new SshError("INVALID_CREDENTIAL", "Sudo passwords must not contain newline or NUL characters");
        this.io.write(value + "\n");
      }).catch(this.io.fail);
    }
  }
  flush() { this.io.output(this.pending); this.pending = Buffer.alloc(0); }
}

export function sudoIdentity(chain: HostProfile[]) {
  return createHash("sha256").update(JSON.stringify(chain.map(h => [h.id, h.hostname, h.port, h.username, h.auth, h.privateKeyPath, h.jumpHostId]))).digest("hex");
}
