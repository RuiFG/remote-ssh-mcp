import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, rm, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import assert from "node:assert/strict";
import { connectMcp, success } from "./mcp-client.ts";

const exec = promisify(execFile);
const directory = await mkdtemp(path.join(tmpdir(), "remote-ssh-mcp-package-"));
try {
  const packed = JSON.parse((await exec("npm", ["pack", "--json", "--pack-destination", directory])).stdout)[0];
  assert.ok(packed.files.some((file: { path: string }) => file.path === "dist/index.js"));
  assert.ok(!packed.files.some((file: { path: string }) => /^(node_modules|test|credentials)\//.test(file.path)));
  await writeFile(path.join(directory, "package.json"), JSON.stringify({ name: "isolated-consumer", private: true, type: "module" }));
  await exec("npm", ["install", "--omit=dev", "--no-audit", "--no-fund", path.join(directory, packed.filename)], { cwd: directory, timeout: 120_000 });
  const installed = path.join(directory, "node_modules/remote-ssh-mcp");
  const manifest = JSON.parse(await readFile(path.join(installed, "package.json"), "utf8"));
  const binary = path.join(directory, "node_modules/.bin/remote-ssh-mcp");
  assert.equal((await exec(binary, ["--version"])).stdout.trim(), `remote-ssh-mcp ${manifest.version}`);
  assert.ok(!Object.keys(manifest.dependencies).some(name => /pi-coding|pi-tui|opencode|typebox/.test(name)));
  const a = await connectMcp(path.join(directory, "data"), directory, path.join(installed, "dist/index.js"));
  let id: string;
  try {
    assert.equal(a.client.getServerVersion()?.version, manifest.version);
    assert.equal((await a.client.listTools()).tools.length, 16);
    const result = success(await a.call("ssh_add_host", { name: "package-fixture", hostname: "127.0.0.1", username: "fixture", auth: "password", credential: "package-fixture-secret" }));
    id = result.host!.id;
  } finally { await a.close(); }
  const b = await connectMcp(path.join(directory, "data"), "/tmp", path.join(installed, "dist/index.js"));
  try { assert.equal(success(await b.call("ssh_list_hosts")).hosts![0].id, id); }
  finally { await b.close(); }
  console.log("Package smoke passed: independent install, 16 MCP tools, persisted host after restart, no Pi/OpenCode runtime dependencies.");
} finally { await rm(directory, { recursive: true, force: true }); }
