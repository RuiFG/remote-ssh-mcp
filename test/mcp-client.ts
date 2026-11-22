import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";

export type Host = { id: string; version: number; name: string; directory?: string; status?: string; changed?: boolean; loginCredentialSaved?: boolean; sudoCredentialSaved?: boolean };
export type Reply = { ok: boolean; code?: string; error?: string; host?: Host; hosts?: Host[]; directory?: string; stdout?: string; stderr?: string; exitCode?: number | null; outcome?: string; timedOut?: boolean; cancelled?: boolean; content?: string; matches?: unknown[]; paths?: string[]; sftp?: boolean; cleanupPending?: boolean; fullOutputPath?: string; displayOutput?: string; truncated?: boolean; displayTruncated?: boolean };
export async function connectMcp(directory: string, cwd = "/tmp", entry = fileURLToPath(new URL("../dist/index.js", import.meta.url))) {
  const transport = new StdioClientTransport({ command: process.execPath, args: [entry], env: { REMOTE_SSH_MCP_DATA_DIR: directory }, stderr: "pipe", cwd });
  let stderr = "";
  transport.stderr?.on("data", data => { stderr += data.toString(); });
  const client = new Client({ name: "remote-ssh-test", version: "1.0.0" });
  try { await client.connect(transport); }
  catch (error) { await transport.close(); throw new Error(`MCP connection failed: ${String(error)}; ${stderr}`); }
  return {
    client, transport, stderr: () => stderr,
    async call(name: string, args: Record<string, unknown> = {}, signal?: AbortSignal): Promise<Reply> {
      const result = await client.callTool({ name, arguments: args }, { timeout: 180_000, signal });
      const parsed = result.structuredContent ?? JSON.parse((result.content.find(c => c.type === "text") as { text: string }).text);
      assert.equal(typeof parsed.ok, "boolean");
      assert.equal(result.isError === true, parsed.ok === false);
      return parsed as Reply;
    },
    close: () => client.close(),
  };
}
export type Peer = Awaited<ReturnType<typeof connectMcp>>;
export function success(result: Reply) { assert.equal(result.ok, true, JSON.stringify(result)); return result; }
