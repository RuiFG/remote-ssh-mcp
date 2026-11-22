import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { readFile, writeFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { randomBytes } from "node:crypto";
import { dockerFixture } from "./docker.ts";
import { connectMcp, success, type Peer, type Host } from "./mcp-client.ts";

describe("independent MCP processes against real OpenSSH", { timeout: 240_000, concurrency: false }, () => {
  let fixture: Awaited<ReturnType<typeof dockerFixture>>, data: string, a: Peer, b: Peer, host: Host;
  const password = "fixture-password";
  const add = (name: string, extra: Record<string, unknown> = {}) => ({ name, hostname: "127.0.0.1", port: fixture.target.port, username: "tester", auth: "password", credential: password, ...extra });
  const find = async (peer: Peer, id: string) => success(await peer.call("ssh_list_hosts")).hosts!.find(h => h.id === id)!;
  const exec = (peer: Peer, hostId: string, command: string, extra: Record<string, unknown> = {}) => peer.call("ssh_shell_exec", { hostId, command, ...extra });
  before(async () => {
    data = await mkdtemp(path.join(tmpdir(), "remote-ssh-mcp-integration-"));
    fixture = await dockerFixture();
    [a, b] = await Promise.all([connectMcp(data, "/tmp"), connectMcp(data, fixture.directory)]);
  });
  after(async () => {
    await Promise.allSettled([a?.close(), b?.close()]);
    await fixture?.close();
    if (data) await rm(data, { recursive: true, force: true });
  });
  it("discovers 16 tools and shares saved hosts/credentials between processes", async () => {
    assert.notEqual(a.transport.pid, b.transport.pid);
    assert.equal((await a.client.listTools()).tools.length, 16);
    host = success(await a.call("ssh_add_host", add("primary"))).host!;
    assert.equal((await find(b, host.id)).name, "primary");
    assert.equal(success(await exec(b, host.id, "printf from-b")).stdout, "from-b");
    const other = success(await b.call("ssh_add_host", add("reverse"))).host!;
    assert.equal(success(await exec(a, other.id, "printf from-a")).stdout, "from-a");
  });
  it("isolates working directories; connection tests preserve workspace; restart restores credentials only", async () => {
    success(await a.call("ssh_set_workspace", { hostId: host.id, path: "/tmp" }));
    assert.equal(success(await exec(a, host.id, "pwd")).stdout?.trim(), "/tmp");
    assert.equal(success(await exec(b, host.id, "pwd")).stdout?.trim(), "/home/tester");
    success(await a.call("ssh_test_connection", { hostId: host.id }));
    assert.equal((await find(a, host.id)).directory, "/tmp");
    process.kill(a.transport.pid!, "SIGKILL");
    await a.close(); a = await connectMcp(data);
    assert.equal((await find(a, host.id)).directory, undefined);
    assert.equal(success(await exec(a, host.id, "pwd")).stdout?.trim(), "/home/tester");
  });
  it("concurrent additions retain both records and stale updates are rejected", async () => {
    const pair = await Promise.all([a.call("ssh_add_host", add("parallel-a")), b.call("ssh_add_host", add("parallel-b"))]);
    pair.forEach(success);
    const names = success(await a.call("ssh_list_hosts")).hosts!.map(h => h.name);
    assert.ok(names.includes("parallel-a") && names.includes("parallel-b"));
    const same = await Promise.all([a.call("ssh_update_host", { hostId: host.id, expectedVersion: host.version, patch: { name: "winner-a" } }), b.call("ssh_update_host", { hostId: host.id, expectedVersion: host.version, patch: { name: "winner-b" } })]);
    assert.equal(same.filter(r => r.ok).length, 1);
    assert.equal(same.find(r => !r.ok)?.code, "HOST_CONFLICT");
    host = await find(a, host.id);
    assert.equal(success(await exec(b, host.id, "printf renamed")).stdout, "renamed");
    assert.equal((await a.call("ssh_add_host", add(host.name))).code, "NAME_EXISTS");
  });
  it("credential changes require reconnect in both clients and temporary overrides never replace saved credentials", async () => {
    host = success(await a.call("ssh_set_credentials", { hostId: host.id, expectedVersion: host.version, kind: "login", credential: password })).host!;
    assert.equal((await exec(b, host.id, "printf blocked")).code, "HOST_CHANGED");
    success(await b.call("ssh_reset_connection", { hostId: host.id }));
    success(await a.call("ssh_reset_connection", { hostId: host.id }));
    success(await a.call("ssh_set_credentials", { hostId: host.id, expectedVersion: host.version, kind: "login", credential: "wrong-temporary", remember: false }));
    assert.equal((await a.call("ssh_reset_connection", { hostId: host.id })).ok, false);
    assert.equal(success(await exec(b, host.id, "printf still-saved")).stdout, "still-saved");
    await a.close(); a = await connectMcp(data);
    assert.equal(success(await exec(a, host.id, "printf restored")).stdout, "restored");
    const temporary = success(await a.call("ssh_add_host", add("temporary-only", { remember: false }))).host!;
    assert.equal(success(await exec(a, temporary.id, "printf temporary")).stdout, "temporary");
    assert.equal((await exec(b, temporary.id, "true")).code, "CREDENTIAL_REQUIRED");
  });
  it("supports key/passphrase login and multi-host jump routing", async () => {
    const key = success(await a.call("ssh_add_host", add("key", { auth: "key", privateKeyPath: fixture.keyPath, credential: undefined }))).host!;
    assert.equal(success(await exec(b, key.id, "printf key-ok")).stdout, "key-ok");
    const encrypted = success(await a.call("ssh_add_host", add("encrypted", { auth: "key", privateKeyPath: fixture.encryptedKeyPath, credential: "fixture-passphrase" }))).host!;
    assert.equal(success(await exec(b, encrypted.id, "printf encrypted-ok")).stdout, "encrypted-ok");
    const jump = success(await a.call("ssh_add_host", add("jump", { port: fixture.jump.port }))).host!;
    const target = success(await a.call("ssh_add_host", add("via-jump", { hostname: "target", port: 22, jumpHostId: jump.id }))).host!;
    assert.equal(success(await exec(b, target.id, "printf jump-ok")).stdout, "jump-ok");
    assert.equal((await a.call("ssh_delete_host", { hostId: jump.id, expectedVersion: jump.version })).code, "HOST_IN_USE");
  });
  it("sudo credentials are explicit, persistent, independent, and command stdin is not authentication input", async () => {
    const missing = await exec(a, host.id, "printf missing-sudo", { sudo: true });
    assert.equal(missing.ok, false); assert.equal(missing.code, "CREDENTIAL_REQUIRED");
    host = success(await a.call("ssh_set_credentials", { hostId: host.id, expectedVersion: host.version, kind: "sudo", reuseSshPassword: true })).host!;
    const result = success(await exec(b, host.id, "id -u; cat", { sudo: true, stdin: "separate-input\n" }));
    assert.equal(result.stdout, "0\nseparate-input\n");
    assert.doesNotMatch(JSON.stringify(result), /fixture-password|remote-ssh-sudo-|remote-ssh-root-/);
    host = success(await a.call("ssh_set_credentials", { hostId: host.id, expectedVersion: host.version, kind: "sudo", credential: "wrong-sudo" })).host!;
    assert.equal((await exec(b, host.id, "printf never", { sudo: true })).code, "SUDO_AUTH_FAILED");
    host = success(await b.call("ssh_set_credentials", { hostId: host.id, expectedVersion: host.version, kind: "sudo", credential: password })).host!;
    assert.equal(success(await exec(a, host.id, "id -u", { sudo: true })).stdout, "0\n");
    const noPass = success(await a.call("ssh_add_host", add("nopass", { username: "nopass" }))).host!;
    assert.equal(success(await exec(b, noPass.id, "id -u", { sudo: true })).stdout, "0\n");
  });
  it("reads/writes/searches and transfers binary files with explicit overwrite", async () => {
    success(await a.call("ssh_write_file", { hostId: host.id, path: "fixture.txt", content: "first\nneedle 中文\nlast\n" }));
    assert.equal((await a.call("ssh_write_file", { hostId: host.id, path: "fixture.txt", content: "overwrite" })).ok, false);
    const read = success(await b.call("ssh_read_file", { hostId: host.id, path: "fixture.txt", startLine: 2, limit: 1 }));
    assert.ok(JSON.stringify(read).includes("needle 中文"));
    assert.ok(JSON.stringify(success(await a.call("ssh_grep", { hostId: host.id, path: ".", include: "fixture.txt", pattern: "needle" }))).includes("needle"));
    assert.ok(JSON.stringify(success(await b.call("ssh_glob", { hostId: host.id, pattern: "*.txt" }))).includes("fixture.txt"));
    const bytes = randomBytes(1024 * 1024), local = path.join(fixture.directory, "payload.bin"), download = path.join(fixture.directory, "download.bin");
    await writeFile(local, bytes);
    success(await a.call("ssh_upload_file", { hostId: host.id, localPath: local, remotePath: "payload.bin" }));
    success(await b.call("ssh_download_file", { hostId: host.id, remotePath: "payload.bin", localPath: download }));
    assert.deepEqual(await readFile(download), bytes);
    assert.equal((await b.call("ssh_download_file", { hostId: host.id, remotePath: "payload.bin", localPath: download })).ok, false);
    success(await b.call("ssh_download_file", { hostId: host.id, remotePath: "payload.bin", localPath: download, overwrite: true }));
  });
  it("shell remains usable without SFTP and output limits preserve complete local log", async () => {
    const noSftp = success(await a.call("ssh_add_host", add("no-sftp", { port: fixture.noSftp.port }))).host!;
    assert.equal(success(await exec(b, noSftp.id, "printf shell-ok")).stdout, "shell-ok");
    assert.equal((await b.call("ssh_read_file", { hostId: noSftp.id, path: "/etc/os-release" })).code, "SFTP_UNAVAILABLE");
    const output = success(await exec(a, host.id, "head -c 30000 /dev/zero | tr '\\000' x"));
    assert.equal(output.displayTruncated, true); assert.ok(output.fullOutputPath);
    assert.equal((await readFile(output.fullOutputPath!, "utf8")).length, 30000);
    await rm(path.dirname(output.fullOutputPath!), { recursive: true, force: true });
    assert.doesNotMatch(a.stderr() + b.stderr(), /fixture-password|wrong-sudo|fixture-passphrase/);
  });
  it("timeout and cancellation do not replay; deletion does not interrupt an issued command", async () => {
    const timeout = await exec(a, host.id, "printf start; sleep 4", { timeoutMs: 30 });
    assert.equal(timeout.ok, false); assert.equal(timeout.timedOut, true);
    const controller = new AbortController();
    const cancelled = a.call("ssh_shell_exec", { hostId: host.id, command: "sleep 4", timeoutMs: 10_000 }, controller.signal);
    setTimeout(() => controller.abort(), 100);
    await assert.rejects(cancelled);
    const victim = success(await a.call("ssh_add_host", add("delete-in-flight"))).host!;
    const marker = `issued-${victim.id}`;
    const pending = exec(a, victim.id, `printf once > ${marker}; sleep 1; printf completed`);
    let issued = false;
    for (let i = 0; i < 40; i++) {
      const result = await exec(b, host.id, `test -f ${marker}`);
      if (result.ok) { issued = true; break; }
      await new Promise(resolve => setTimeout(resolve, 30));
    }
    assert.ok(issued);
    success(await b.call("ssh_delete_host", { hostId: victim.id, expectedVersion: 1 }));
    assert.equal(success(await pending).stdout, "completed");
    assert.equal((await exec(a, victim.id, "true")).code, "HOST_NOT_FOUND");
    assert.equal(success(await exec(b, host.id, `cat ${marker}`)).stdout, "once");
  });
  it("network loss yields unknown outcome without automatic replay; changed host keys are rejected", async () => {
    const pending = exec(a, host.id, "printf before-loss; sleep 10; printf after-loss");
    void pending.catch(() => {});
    await new Promise(resolve => setTimeout(resolve, 300));
    const processes = await fixture.docker("exec", fixture.target.name, "ps", "-eo", "pid,comm");
    const pids = processes.split("\n").map(line => /^\s*(\d+)\s+sshd(?:-session)?(?:\s|:|$)/.exec(line)?.[1]).filter((pid): pid is string => !!pid && pid !== "1");
    assert.ok(pids.length > 0, processes);
    await fixture.docker("exec", fixture.target.name, "kill", "-9", ...pids);
    const result = await pending;
    assert.equal(result.ok, false); assert.equal(result.outcome, "unknown"); assert.equal(result.exitCode, null);
    let reconnected;
    for (let attempt = 0; attempt < 20; attempt++) {
      reconnected = await exec(a, host.id, "printf reconnected");
      if (reconnected.ok) break;
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    assert.equal(success(reconnected!).stdout, "reconnected");
    const pinsFile = path.join(data, "known-hosts.json"), pins = JSON.parse(await readFile(pinsFile, "utf8"));
    pins[JSON.stringify(["127.0.0.1", fixture.target.port])].fingerprint = "SHA256:changed-fixture";
    await writeFile(pinsFile, JSON.stringify(pins), { mode: 0o600 });
    assert.equal((await a.call("ssh_reset_connection", { hostId: host.id })).code, "HOST_KEY_CHANGED");
    success(await b.call("ssh_forget_host_key", { hostId: host.id, expectedVersion: host.version }));
    success(await a.call("ssh_reset_connection", { hostId: host.id }));
  });
});
