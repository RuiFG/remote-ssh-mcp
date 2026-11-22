/** Explicit opt-in: runs the installed coding clients and may make billable model requests. */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
import { dockerFixture } from "./docker.ts";
import { connectMcp, success } from "./mcp-client.ts";

const exec = promisify(execFile);
const directory = await mkdtemp(path.join(tmpdir(), "remote-ssh-native-"));
const entry = fileURLToPath(new URL("../dist/index.js", import.meta.url));
let fixture: Awaited<ReturnType<typeof dockerFixture>> | undefined;
const evidence: Record<string, unknown> = { directory };
async function run(binary: string, args: string[]) {
  try {
    const pending = exec(binary, args, { cwd: directory, timeout: 180_000, maxBuffer: 16 * 1024 * 1024 });
    pending.child.stdin?.end();
    const result = await pending;
    await writeFile(path.join(directory, `${binary}.jsonl`), result.stdout, { mode: 0o600 });
    await writeFile(path.join(directory, `${binary}.stderr`), result.stderr, { mode: 0o600 });
    return result.stdout;
  } catch (error) {
    const e = error as Error & { stdout?: string; stderr?: string };
    await writeFile(path.join(directory, `${binary}.jsonl`), e.stdout ?? "", { mode: 0o600 });
    await writeFile(path.join(directory, `${binary}.stderr`), e.stderr ?? "", { mode: 0o600 });
    throw new Error(`${binary} failed; inspect ${directory}/${binary}.stderr and .jsonl`);
  }
}
try {
  fixture = await dockerFixture();
  const data = path.join(directory, "data");
  const config = path.join(directory, "mcp.json");
  await writeFile(config, JSON.stringify({ mcpServers: { remote_ssh_fixture: { type: "stdio", command: process.execPath, args: [entry], env: { REMOTE_SSH_MCP_DATA_DIR: data } } } }), { mode: 0o600 });
  console.log("Native Codex: create a fixture host through MCP and execute a command.");
  const prompt = `This is an authorized integration test against an isolated local OpenSSH container. Use ONLY the remote_ssh_fixture MCP tools, no shell/file/web tools. Call ssh_add_host exactly once with ${JSON.stringify({ name: "native-client-fixture", hostname: "127.0.0.1", port: fixture.target.port, username: "tester", auth: "password", credential: "fixture-password" })}. Then call ssh_shell_exec on the returned host ID with command "printf codex-ok". Report the actual output. Do not create or edit source files. The password is a disposable public fixture credential.`;
  const configured = JSON.parse((await exec("codex", ["mcp", "list", "--json"])).stdout) as { name: string }[];
  const disabled = configured.filter(item => item.name !== "remote_ssh_fixture").flatMap(item => ["-c", `mcp_servers.${item.name}.enabled=false`]);
  const codex = await run("codex", ["-a", "never", "exec", "--ephemeral", "--skip-git-repo-check", "--json", "--sandbox", "read-only", ...disabled, "-c", "features.apps=false", "-c", `mcp_servers.remote_ssh_fixture.command=${JSON.stringify(process.execPath)}`, "-c", `mcp_servers.remote_ssh_fixture.args=[${JSON.stringify(entry)}]`, "-c", `mcp_servers.remote_ssh_fixture.env.REMOTE_SSH_MCP_DATA_DIR=${JSON.stringify(data)}`, "-c", "mcp_servers.remote_ssh_fixture.tool_timeout_sec=180", "-c", 'mcp_servers.remote_ssh_fixture.enabled_tools=["ssh_add_host","ssh_shell_exec"]', "-c", 'mcp_servers.remote_ssh_fixture.tools.ssh_add_host.approval_mode="approve"', "-c", 'mcp_servers.remote_ssh_fixture.tools.ssh_shell_exec.approval_mode="approve"', prompt]);
  const peer = await connectMcp(data);
  let host;
  try { host = success(await peer.call("ssh_list_hosts")).hosts!.find(h => h.name === "native-client-fixture"); }
  finally { await peer.close(); }
  assert.ok(host, "Codex did not create the host through MCP");
  const codexCalls = codex.trim().split("\n").map(line => JSON.parse(line) as {
    type: string;
    item?: { type: string; tool?: string; status?: string; result?: { structured_content?: { host?: { id: string }; stdout?: string; exitCode?: number } } };
  }).filter(event => event.type === "item.completed" && event.item?.type === "mcp_tool_call").map(event => event.item!);
  const additions = codexCalls.filter(call => call.tool === "ssh_add_host");
  assert.equal(additions.length, 1, "Expected exactly one Codex host creation");
  assert.equal(additions[0].result?.structured_content?.host?.id, host.id);
  const codexCommand = codexCalls.find(call => call.tool === "ssh_shell_exec");
  assert.equal(codexCommand?.status, "completed");
  assert.equal(codexCommand?.result?.structured_content?.stdout, "codex-ok");
  assert.equal(codexCommand?.result?.structured_content?.exitCode, 0);
  evidence.codex = { hostCreated: true, commandOutput: "codex-ok" };
  console.log("Native Codex passed; native Claude will read the same host and execute via MCP.");
  const claudePrompt = "This is an authorized integration test against an isolated local OpenSSH container. Use ONLY the remote_ssh_fixture MCP tools. Call ssh_list_hosts and find native-client-fixture, already saved by Codex. Use its exact ID to call ssh_shell_exec with command: printf claude-ok > /home/tester/claude-native-marker; cat /home/tester/claude-native-marker . Report actual output. Do not add a host, change credentials, or use any other tools.";
  const claude = await run("claude", ["-p", claudePrompt, "--strict-mcp-config", "--mcp-config", config, "--tools", "", "--allowedTools", "mcp__remote_ssh_fixture__ssh_list_hosts,mcp__remote_ssh_fixture__ssh_shell_exec", "--no-session-persistence", "--output-format", "stream-json", "--verbose", "--max-budget-usd", "2", "--settings", '{"disableAllHooks":true}']);
  const claudeResults = claude.trim().split("\n").map(line => JSON.parse(line) as {
    type: string;
    tool_use_result?: { structuredContent?: { hosts?: { id: string }[]; stdout?: string; exitCode?: number } };
  }).filter(event => event.type === "user").map(event => event.tool_use_result?.structuredContent);
  assert.ok(claudeResults.some(result => result?.hosts?.some(item => item.id === host.id)), "Claude did not discover the shared host");
  assert.ok(claudeResults.some(result => result?.stdout === "claude-ok" && result.exitCode === 0), "Missing successful Claude tool-result evidence");
  const verifier = await connectMcp(data);
  try {
    const result = success(await verifier.call("ssh_shell_exec", { hostId: host.id, command: "cat /home/tester/claude-native-marker" }));
    assert.equal(result.stdout, "claude-ok");
  } finally { await verifier.close(); }
  evidence.claude = { sharedHostUsed: true, commandOutputVerified: "claude-ok" };
  await writeFile(path.join(directory, "evidence.json"), JSON.stringify(evidence, null, 2), { mode: 0o600 });
  console.log(JSON.stringify(evidence));
} finally {
  await fixture?.close();
  // Keep synthetic transcripts for inspection, but remove temporary stored credentials.
  await rm(path.join(directory, "data"), { recursive: true, force: true });
}
