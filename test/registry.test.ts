import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { readFile, writeFile, unlink, stat } from "node:fs/promises";
import { Registry } from "../src/registry.ts";
import { EncryptedFileSecrets } from "../src/credentials.ts";
import { MemoryVault, temporary } from "./helpers.ts";
import { dataDirectory } from "../src/paths.ts";
import { homedir } from "node:os";

const draft = (name: string) => ({ name, hostname: "127.0.0.1", username: "tester", auth: "password" as const });

test("shared storage never silently resolves against a client's project directory", () => {
  assert.equal(dataDirectory({}), path.join(homedir(), ".local/share/remote-ssh-mcp"));
  assert.equal(dataDirectory({ XDG_DATA_HOME: "relative" }), dataDirectory({}));
  assert.equal(dataDirectory({ XDG_DATA_HOME: "/tmp/xdg-fixture" }), "/tmp/xdg-fixture/remote-ssh-mcp");
  assert.equal(dataDirectory({ REMOTE_SSH_MCP_DATA_DIR: "~/mcp-fixture" }), path.join(homedir(), "mcp-fixture"));
  assert.throws(() => dataDirectory({ REMOTE_SSH_MCP_DATA_DIR: "relative" }), { code: "INVALID_DATA_DIRECTORY" });
});

test("remembered login and sudo survive restart; neither outputs nor profile files contain secrets", async t => {
  const temp = await temporary(); t.after(temp.close);
  const a = new Registry(temp.directory);
  const added = await a.add(draft("alpha"), "login-fixture-secret");
  const sudo = await a.setCredential(added.host.id, 1, { kind: "sudo", credential: "sudo-fixture-secret" });
  assert.equal(sudo.host.version, 2);
  a.close();
  const b = new Registry(temp.directory); await b.load();
  const host = b.profiles.get(added.host.id);
  assert.equal(await b.loginSecret(host), "login-fixture-secret");
  assert.equal(await b.sudoSecret(host, host.sudoIdentity!), "sudo-fixture-secret");
  assert.doesNotMatch(JSON.stringify([added, sudo]), /login-fixture-secret|sudo-fixture-secret/);
  assert.doesNotMatch(await readFile(path.join(temp.directory, "hosts.json"), "utf8"), /login-fixture-secret|sudo-fixture-secret/);
  assert.doesNotMatch(await readFile(path.join(temp.directory, "credentials/vault.json"), "utf8"), /login-fixture-secret|sudo-fixture-secret/);
  assert.equal((await stat(path.join(temp.directory, "credentials/key"))).mode & 0o077, 0);
});

test("temporary login overlays saved credentials only in its context; new temporary hosts have no shared secret reference", async t => {
  const temp = await temporary(); t.after(temp.close);
  const a = new Registry(temp.directory), b = new Registry(temp.directory);
  const { host } = await a.add(draft("saved"), "saved");
  await a.setCredential(host.id, host.version, { kind: "login", credential: "temporary", remember: false });
  await b.load();
  assert.equal(await a.loginSecret(a.profiles.get(host.id)), "temporary");
  assert.equal(await b.loginSecret(b.profiles.get(host.id)), "saved");
  const fresh = await a.add(draft("temporary-only"), "unshared", false);
  await b.load();
  assert.equal(b.profiles.get(fresh.host.id).credentialId, undefined);
  assert.equal(await b.loginSecret(b.profiles.get(fresh.host.id)), undefined);
  assert.equal(await a.loginSecret(a.profiles.get(fresh.host.id)), "unshared");
  a.close();
  const c = new Registry(temp.directory); await c.load();
  assert.equal(await c.loginSecret(c.profiles.get(host.id)), "saved");
});

test("concurrent writers retain different hosts and reject same-version edits and duplicate names", async t => {
  const temp = await temporary(); t.after(temp.close);
  const a = new Registry(temp.directory), b = new Registry(temp.directory);
  const [one, two] = await Promise.all([a.add(draft("one")), b.add(draft("two"))]);
  await a.load(); assert.equal(a.profiles.list().length, 2);
  const results = await Promise.allSettled([a.update(one.host.id, 1, { name: "renamed-a" }), b.update(one.host.id, 1, { name: "renamed-b" })]);
  assert.equal(results.filter(r => r.status === "fulfilled").length, 1);
  const failed = results.find(r => r.status === "rejected") as PromiseRejectedResult;
  assert.equal(failed.reason.code, "HOST_CONFLICT");
  await assert.rejects(a.add(draft("TWO")), { code: "NAME_EXISTS" });
  await assert.rejects(b.remove(two.host.id, 8), { code: "HOST_CONFLICT" });
});

test("rename keeps connection identity; endpoint change clears credentials; invalid jump changes do not commit", async t => {
  const temp = await temporary(); t.after(temp.close);
  const vault = new MemoryVault(), store = new Registry(temp.directory, vault);
  const { host } = await store.add(draft("original"), "original-secret");
  const renamed = await store.update(host.id, 1, { name: "renamed" });
  assert.equal(store.profiles.get(host.id).revision, 1);
  await assert.rejects(store.update(host.id, 2, { jumpHostId: host.id }), { code: "JUMP_CYCLE" });
  await store.load(); assert.equal(store.profiles.get(host.id).version, renamed.host.version);
  const changed = await store.update(host.id, 2, { hostname: "different.test" });
  assert.equal(changed.host.loginCredentialSaved, false);
  assert.equal(await store.loginSecret(store.profiles.get(host.id)), undefined);
  assert.equal(vault.values.size, 0);
});

test("failed profile commit keeps old credential usable and removes the staged secret", async t => {
  const temp = await temporary(); t.after(temp.close);
  const vault = new MemoryVault(), store = new Registry(temp.directory, vault);
  const { host } = await store.add(draft("host"), "original");
  const commit = store.profiles.commit.bind(store.profiles);
  store.profiles.commit = async () => { throw new Error("injected disk failure"); };
  await assert.rejects(store.setCredential(host.id, 1, { kind: "login", credential: "replacement" }), /injected/);
  store.profiles.commit = commit;
  await store.load(); assert.equal(store.profiles.get(host.id).version, 1);
  assert.equal(await store.loginSecret(store.profiles.get(host.id)), "original");
  assert.deepEqual([...vault.values.values()], ["original"]);
});

test("cleanup failure is reported and recovered without deleting live references after restart", async t => {
  const temp = await temporary(); t.after(temp.close);
  class FaultVault extends MemoryVault { fail = false; override async delete(id: string) { if (this.fail) throw new Error("cleanup failed"); await super.delete(id); } }
  const vault = new FaultVault(), store = new Registry(temp.directory, vault);
  const { host } = await store.add(draft("host"), "original");
  vault.fail = true;
  const changed = await store.setCredential(host.id, 1, { kind: "login", credential: "replacement" });
  assert.equal(changed.cleanupPending, true); assert.equal(vault.values.size, 2);
  // Simulate a crash after committing a staged ID but before clearing its journal entry.
  const journal = path.join(temp.directory, "pending-cleanup.json");
  const ids = JSON.parse(await readFile(journal, "utf8"));
  await writeFile(journal, JSON.stringify([...ids, store.profiles.get(host.id).credentialId]), { mode: 0o600 });
  vault.fail = false;
  const restarted = new Registry(temp.directory, vault);
  await restarted.add(draft("next"));
  assert.deepEqual([...vault.values.values()], ["replacement"]);
  assert.equal(await restarted.loginSecret(restarted.profiles.get(host.id)), "replacement");
});

test("missing encryption key fails closed and does not replace the existing vault", async t => {
  const temp = await temporary(); t.after(temp.close);
  const store = new Registry(temp.directory);
  const { host } = await store.add(draft("host"), "saved-secret");
  const file = path.join(temp.directory, "credentials/vault.json"), original = await readFile(file);
  await unlink(path.join(temp.directory, "credentials/key"));
  await assert.rejects(new EncryptedFileSecrets(path.join(temp.directory, "credentials")).get(store.profiles.get(host.id).credentialId!), { code: "VAULT_UNAVAILABLE" });
  await assert.rejects(store.setCredential(host.id, 1, { kind: "login", credential: "replacement" }), { code: "VAULT_UNAVAILABLE" });
  assert.deepEqual(await readFile(file), original);
  await store.load(); assert.equal(store.profiles.get(host.id).version, 1);
});

test("referenced jumps cannot be deleted; sudo requires explicit reuse", async t => {
  const temp = await temporary(); t.after(temp.close);
  const store = new Registry(temp.directory);
  const jump = await store.add(draft("jump"), "login-password");
  const target = await store.add({ ...draft("target"), jumpHostId: jump.host.id });
  await assert.rejects(store.remove(jump.host.id, 1), { code: "HOST_IN_USE" });
  await assert.rejects(store.setCredential(jump.host.id, 1, { kind: "sudo" }), { code: "CREDENTIAL_REQUIRED" });
  const saved = await store.setCredential(jump.host.id, 1, { kind: "sudo", reuseSshPassword: true });
  const profile = store.profiles.get(jump.host.id);
  assert.equal(await store.sudoSecret(profile, profile.sudoIdentity!), "login-password");
  await store.remove(target.host.id, 1); await store.remove(jump.host.id, saved.host.version);
  assert.equal(store.profiles.list().length, 0);
});

test("a UUID-shaped name cannot shadow another host's stable ID", async t => {
  const temp = await temporary(); t.after(temp.close);
  const store = new Registry(temp.directory);
  const first = await store.add(draft("first"));
  const second = await store.add(draft("second"));
  await store.update(first.host.id, 1, { name: second.host.id });
  assert.equal(store.profiles.get(second.host.id).name, "second");
  await assert.rejects(store.update("second", 1, { name: "renamed" }), { code: "HOST_NOT_FOUND" });
});
