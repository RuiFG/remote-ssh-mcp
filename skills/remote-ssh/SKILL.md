---
name: remote-ssh
description: "Manage persistent SSH hosts, credentials, remote commands, and SFTP files through the remote-ssh MCP server. Use when adding or updating remote-ssh hosts, or inspecting, operating on, or transferring files to configured hosts. Not for configuring the VS Code Remote-SSH extension."
---

# Remote SSH

Use the `remote-ssh` MCP tools available in the current client. This guide uses the short `ssh_*` names; use the tool prefixes and parameter schemas exposed by the client.

Clients using the same data directory share host profiles, saved credentials, and server fingerprints. SSH connections, remote working directories, and temporary credentials belong to the current MCP session. Manage this state through MCP rather than editing `hosts.json`, the credential vault, or ordinary `~/.ssh/config` entries.

## Select a host

- Start with `ssh_list_hosts`. Match the name or address and check `hostname`, `port`, and `username` to obtain the stable `id` and current `version`. Operations on existing hosts require `hostId`, not a name or an ID recalled from memory.
- The same address may have different accounts, ports, or jump-host routes. Reuse an existing matching profile or update it as requested. Ask only when the intended target is ambiguous.
- `status: disconnected` means this session has no connection; it does not mean the host is offline or lacks credentials. Try saved credentials before asking for them again.

## Add or update hosts

1. Obtain the address, account, port, and authentication method from the request, current host records, or existing configuration relevant to the task. Use port 22 when unspecified. Ask only for missing account details or required credentials; do not guess accounts or assume another host's password applies.
2. Create the profile with `ssh_add_host`. Pass passwords in `credential`. For key authentication, use `auth: "key"` and an absolute `privateKeyPath` readable on the MCP server's machine; pass an encrypted key's passphrase in `credential`. Use an existing host's `jumpHostId` for a jump host.
3. Credentials default to `remember: true` and are available to clients sharing the data directory. Use `false` when the user requests session-only credentials. A temporary override neither deletes saved credentials nor shares the override with other clients.
4. Supply the current `expectedVersion` when updating, deleting, setting credentials, or resetting trust. Renaming preserves the ID. Changes to the address, account, authentication identity, or jump-host identity clear old login and sudo credentials; set credentials for the new identity. Apply changes to an existing connection with `ssh_reset_connection`.
5. After adding or changing login configuration, call `ssh_test_connection` and check `exec` and `sftp` separately. The test uses a temporary connection without changing the current working directory. If saving succeeds but login fails, report "saved, connection verification failed" with the cause; do not repeatedly create new profiles.

Pass passwords and key passphrases only through MCP credential parameters, never through remote commands, `stdin`, reports, or skill files. Complete already-authorized host operations without introducing another confirmation process.

## Commands and files

- Use `ssh_set_workspace` to set the directory for subsequent operations on that host. The first connection starts in the remote home directory. A `cd` inside one command does not change the session directory, and other clients do not inherit it.
- Use `ssh_shell_exec` for commands. Before platform-dependent operations, identify the environment with a small read-only probe such as `uname -s`, then choose commands supported by the actual Linux, macOS, or BusyBox environment. A host name does not establish GNU utility availability.
- Use `sudo: true` when elevation is needed; it elevates the entire command. Sudo credentials are separate from login credentials and are set with `ssh_set_credentials(kind: "sudo")`. Use `reuseSshPassword: true` only when reuse of the login password is explicitly established. Passwordless sudo does not require a stored password.
- Read and search text with `ssh_read_file`, `ssh_grep`, and `ssh_glob`; write text with `ssh_write_file`; transfer binary or complete files with `ssh_upload_file` and `ssh_download_file`. Bound directories, line ranges, and result counts as needed.
- Transfers operate on a single file. Supply the full destination file path and ensure its parent directory exists. Set `overwrite: true` only when the task calls for replacing an existing file. Create directories, move files, and delete files through remote commands.
- Local paths refer to the **MCP server's machine**. Relative local paths resolve against the server's startup directory, not the current chat's working directory; use absolute paths. Relative remote paths resolve against that host's session directory, with support for `~` and `~/`.
- For truncated output, narrow the read or inspect the returned `fullOutputPath` on the MCP server's machine; it is not a remote path. Do not rerun a command with side effects merely to recover its full output.

## Failures and recovery

| Condition | Action |
| --- | --- |
| `HOST_CONFLICT` | List hosts again, inspect the concurrent change, and decide whether the original request still applies. Do not merely substitute the new version to force an overwrite. |
| `HOST_CHANGED` | Check the current configuration and credentials, then use `ssh_reset_connection`. Reconnecting does not replay commands. |
| Missing or rejected credentials | Correct them with `ssh_set_credentials`; reset an existing login connection. Do not repeatedly guess passwords. |
| `HOST_KEY_CHANGED` | Stop connecting to that host and independently verify its identity. Use `ssh_forget_host_key` only after identity verification and user authorization to update trust, then reconnect. Never clear trust automatically to bypass the error. |
| `outcome: "unknown"`, interruption, timeout, or cancellation | The remote command may still be running or may have completed. Inspect processes, logs, or result files through read-only checks before deciding what to do; never replay automatically. If a command has side effects and its outcome remains uncertain, stop and explain that uncertainty. |
| SSH works but `sftp: false` | Report the capabilities separately. Do not claim file transfers were verified or install remote components without authorization. |

Commands default to a 120-second timeout. `timeoutMs: 0` disables only the server's command timer; the client may still time out. Check `ok`, `exitCode`, `outcome`, `timedOut`, and `cancelled` rather than treating a returned tool call as command success. A successful connection test does not establish application health.

If MCP tools are unavailable, identify the missing connection. Inspect client launch commands and `REMOTE_SSH_MCP_DATA_DIR` when installation or MCP troubleshooting is requested. Cross-client sharing requires the same absolute data directory; registering an MCP server under the same name in both clients is insufficient evidence. Do not replace the user's SSH tooling or modify unrelated client configuration to complete a remote operation.
