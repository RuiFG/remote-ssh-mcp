#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/server/stdio";
import { createServer } from "./server.ts";
import { dataDirectory } from "./paths.ts";
import manifest from "../package.json" with { type: "json" };

if (process.argv.includes("--version")) {
  process.stdout.write(`remote-ssh-mcp ${manifest.version}\n`);
} else if (process.argv.includes("--help")) {
  process.stdout.write("remote-ssh-mcp: persistent SSH tools over MCP stdio\nSet REMOTE_SSH_MCP_DATA_DIR to share a specific data directory.\nDefault: $XDG_DATA_HOME/remote-ssh-mcp or ~/.local/share/remote-ssh-mcp\n");
} else {
  process.umask(0o077);
  try {
    const { server, runtime } = await createServer(dataDirectory());
    let closing = false;
    const close = () => {
      if (closing) return; closing = true; runtime.close();
      void server.close().finally(() => { process.exitCode = 0; });
    };
    process.once("SIGINT", close); process.once("SIGTERM", close);
    await server.connect(new StdioServerTransport());
  } catch {
    process.stderr.write("remote-ssh-mcp: startup failed; check the shared data directory and stored file format\n");
    process.exitCode = 1;
  }
}
