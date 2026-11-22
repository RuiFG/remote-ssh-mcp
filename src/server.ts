import { McpServer, type CallToolResult, type ServerContext } from "@modelcontextprotocol/server";
import { RemoteRuntime } from "./runtime.ts";
import { schemas, descriptions, READ_ONLY, executeTool, toolResult, type ToolName } from "./tools.ts";
import { managementSchemas, managementDescriptions, executeManagement, type ManagementToolName } from "./management.ts";
import { failure } from "./domain.ts";
import manifest from "../package.json" with { type: "json" };

export async function createServer(directory: string, cwd = process.cwd()) {
  const runtime = new RemoteRuntime(directory);
  await runtime.load();
  const server = new McpServer({ name: "remote-ssh-mcp", version: manifest.version }, { instructions: "Shared persistent SSH hosts. Start with ssh_list_hosts; always use explicit hostId. Supply credentials directly with ssh_add_host or ssh_set_credentials. Never automatically replay a command with unknown outcome. Local transfer paths resolve against the MCP server startup directory; prefer absolute paths." });
  const all = { ...schemas, ...managementSchemas };
  for (const [name, schema] of Object.entries(all)) {
    const execution = name in schemas;
    server.registerTool(name, {
      description: execution ? descriptions[name as ToolName] : managementDescriptions[name as ManagementToolName],
      inputSchema: schema,
      annotations: { readOnlyHint: execution && READ_ONLY.has(name as ToolName), destructiveHint: !(execution && READ_ONLY.has(name as ToolName)), openWorldHint: true, idempotentHint: false },
    }, async (args: unknown, ctx: ServerContext) => {
      try {
        const env = { runtime, sessionId: "mcp", cwd, signal: ctx.mcpReq.signal };
        const result = execution ? await executeTool(name as ToolName, args, env) : await executeManagement(name as ManagementToolName, args, env);
        return toolResult(result) as CallToolResult;
      } catch (error) { return toolResult(failure(error)) as CallToolResult; }
    });
  }
  server.server.onclose = () => runtime.close();
  // Protocol errors are handled by the SDK. Do not log incoming messages or credentials.
  server.server.onerror = () => { process.stderr.write("remote-ssh-mcp: protocol error\n"); };
  return { server, runtime };
}
