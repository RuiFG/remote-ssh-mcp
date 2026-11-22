import { z } from "zod";
import { HostInput, checkAbort } from "./domain.ts";
import type { ToolEnvironment } from "./tools.ts";

const hostId = z.string().uuid().describe("Stable ID from ssh_list_hosts");
const expectedVersion = z.number().int().positive().describe("Current host version from ssh_list_hosts; stale writes return HOST_CONFLICT");
const credential = z.string().max(64 * 1024).describe("SSH password, private-key passphrase, or sudo password. Never echoed in results.");
const fields = HostInput.shape;
export const managementSchemas = {
  ssh_add_host: z.object({ name: fields.name, hostname: fields.hostname, port: fields.port, username: fields.username, auth: fields.auth, privateKeyPath: fields.privateKeyPath, jumpHostId: fields.jumpHostId, credential: credential.optional(), remember: z.boolean().default(true) }).strict(),
  ssh_update_host: z.object({ hostId, expectedVersion, patch: z.object({ name: fields.name.optional(), hostname: fields.hostname.optional(), port: z.number().int().min(1).max(65535).optional(), username: fields.username.optional(), auth: fields.auth.optional(), privateKeyPath: z.string().min(1).nullable().optional(), jumpHostId: z.string().uuid().nullable().optional() }).strict() }).strict(),
  ssh_delete_host: z.object({ hostId, expectedVersion }).strict(),
  ssh_test_connection: z.object({ hostId }).strict(),
  ssh_set_credentials: z.object({ hostId, expectedVersion, kind: z.enum(["login", "sudo"]), credential: credential.optional(), reuseSshPassword: z.boolean().default(false), remember: z.boolean().default(true) }).strict(),
  ssh_forget_host_key: z.object({ hostId, expectedVersion }).strict(),
};
export type ManagementToolName = keyof typeof managementSchemas;
export const managementDescriptions: Record<ManagementToolName, string> = {
  ssh_add_host: "Persist a new uniquely named SSH host shared by Codex and Claude. For password auth provide credential; for key auth provide privateKeyPath and optional credential passphrase. Credentials are remembered by default; remember:false uses this MCP connection only. Returns stable ID and version. No interactive dialog.",
  ssh_update_host: "Update host fields with optimistic version checking. Null clears a jump host or private-key path. Connection identity changes clear saved login/sudo credentials to prevent reuse on a different endpoint; set credentials again. Existing connections require ssh_reset_connection. Rename preserves the ID.",
  ssh_delete_host: "Delete a host and its credentials using expectedVersion. New operations in all clients fail afterward; already-started commands are not forcibly interrupted. Referenced jump hosts cannot be deleted. cleanupPending:true means credential cleanup must be retried by a later management operation.",
  ssh_test_connection: "Test SSH and SFTP with a temporary connection. Does not change this MCP connection's workspace or working SSH connection. Missing credentials fail immediately; set them with ssh_set_credentials.",
  ssh_set_credentials: "Set login or sudo credential, remembered by default and shared across clients. remember:false overlays it only for this MCP connection without deleting saved credentials. For sudo explicitly provide credential OR reuseSshPassword:true. Login credential changes require ssh_reset_connection for existing connections. Returns the latest host version; never returns secret values.",
  ssh_forget_host_key: "Explicitly forget this host endpoint's trusted SSH fingerprint after independently verifying its identity. Next fresh connection records a new fingerprint. Existing connections are not retroactively reverified; reset them explicitly. Never use automatically to bypass a fingerprint mismatch.",
};

export async function executeManagement(name: ManagementToolName, input: unknown, env: ToolEnvironment): Promise<Record<string, unknown>> {
  checkAbort(env.signal);
  const { runtime } = env, registry = runtime.registry;
  switch (name) {
    case "ssh_add_host": {
      const { credential, remember, ...draft } = managementSchemas[name].parse(input);
      return { ok: true, ...await registry.add(draft, credential, remember) };
    }
    case "ssh_update_host": {
      const args = managementSchemas[name].parse(input);
      return { ok: true, ...await registry.update(args.hostId, args.expectedVersion, args.patch) };
    }
    case "ssh_delete_host": {
      const args = managementSchemas[name].parse(input);
      const result = await registry.remove(args.hostId, args.expectedVersion);
      runtime.prune(); return { ok: true, ...result };
    }
    case "ssh_test_connection": {
      const args = managementSchemas[name].parse(input);
      await registry.load();
      return runtime.operation(args.hostId, async () => ({ ok: true, hostId: args.hostId, ...await runtime.test(args.hostId, env.signal) }));
    }
    case "ssh_set_credentials": {
      const { hostId, expectedVersion, ...args } = managementSchemas[name].parse(input);
      const result = await registry.setCredential(hostId, expectedVersion, args);
      if (args.kind === "login") runtime.invalidateCredential(hostId);
      return { ok: true, ...result };
    }
    case "ssh_forget_host_key": {
      const args = managementSchemas[name].parse(input);
      return { ok: true, ...await registry.forgetKey(args.hostId, args.expectedVersion) };
    }
  }
}
