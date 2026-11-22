import { test } from "node:test";
import assert from "node:assert/strict";
import { SudoExchange } from "../src/sudo.ts";

test("fragmented sudo markers never mix command stdin with password input", async () => {
  const writes: string[] = [], output: Buffer[] = [];
  let ready = false;
  const exchange = new SudoExchange({
    signal: new AbortController().signal, password: async () => "test-password",
    write: value => { writes.push(value); }, output: value => { output.push(value); },
    ready: () => { ready = true; writes.push("command-input"); }, fail: error => { throw error; },
  });
  const command = exchange.command("cat; printf '%s' 'quoted command'");
  assert.ok(!command.includes("test-password"));
  const prompt = /remote-ssh-sudo-[\da-f-]+/.exec(command)![0];
  const marker = /remote-ssh-root-[\da-f-]+/.exec(command)![0];
  for (const byte of Buffer.from(`notice\n${prompt}`)) exchange.push(Buffer.from([byte]));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(ready, false); assert.deepEqual(writes, ["test-password\n"]);
  for (const byte of Buffer.from(marker + "diagnostic\n")) exchange.push(Buffer.from([byte]));
  exchange.flush();
  assert.equal(ready, true); assert.deepEqual(writes, ["test-password\n", "command-input"]);
  assert.equal(Buffer.concat(output).toString(), "notice\ndiagnostic\n");
});
