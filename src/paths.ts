import path from "node:path";
import { homedir } from "node:os";
import { SshError } from "./domain.ts";

export function localPath(value: string, base = process.cwd()) {
  if (value.includes("\0")) throw new SshError("INVALID_PATH", "Path contains NUL");
  if (value === "~") return homedir();
  if (/^~[/\\]/.test(value)) return path.resolve(homedir(), value.slice(2));
  return path.resolve(base, value);
}
export function remotePath(value: string | undefined, directory: string, home: string) {
  const input = value ?? ".";
  if (input.includes("\0")) throw new SshError("INVALID_PATH", "Path contains NUL");
  if (input.startsWith("~") && input !== "~" && !input.startsWith("~/")) {
    throw new SshError("INVALID_PATH", "Only ~ and ~/ are supported; ~other-user is not expanded");
  }
  return path.posix.resolve(directory, input === "~" ? home : input.startsWith("~/") ? `${home}/${input.slice(2)}` : input);
}
export function quote(value: string) {
  if (value.includes("\0")) throw new SshError("INVALID_ARGUMENT", "Argument contains NUL");
  return `'${value.replaceAll("'", "'\\''")}'`;
}
export function dataDirectory(env: NodeJS.ProcessEnv = process.env) {
  const override = env.REMOTE_SSH_MCP_DATA_DIR;
  if (override) {
    const expanded = override === "~" ? homedir() : override.startsWith("~/") ? path.join(homedir(), override.slice(2)) : override;
    if (!path.isAbsolute(expanded)) throw new SshError("INVALID_DATA_DIRECTORY", "REMOTE_SSH_MCP_DATA_DIR must be absolute so clients share the same host registry");
    return path.normalize(expanded);
  }
  const xdg = env.XDG_DATA_HOME;
  return path.join(xdg && path.isAbsolute(xdg) ? xdg : path.join(homedir(), ".local", "share"), "remote-ssh-mcp");
}
