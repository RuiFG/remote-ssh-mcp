# Remote SSH MCP

在 Codex CLI 和 Claude Code 中管理 SSH 主机、运行远端命令、传输文件。Windows 和 WSL 客户端可以共用 WSL 中安装的一份服务、同一份主机列表与已保存凭据。每个会话拥有独立的 SSH 连接和远端工作目录。

## 安装 v1.0.0

在 WSL 或 Linux 中运行以下命令。需要 Node.js 22.19.0 或更高版本和 npm。远端机器需要 SSH 服务，文件传输还需要 SFTP。

```bash
npm install --global --prefix "$HOME/.local" https://github.com/RuiFG/remote-ssh-mcp/releases/download/v1.0.0/remote-ssh-mcp-1.0.0.tgz
"$HOME/.local/bin/remote-ssh-mcp" --version
```

此安装包包含已编译的 MCP 服务、操作指引和许可证。版本命令应输出 `remote-ssh-mcp 1.0.0`。[下载 v1.0.0](https://github.com/RuiFG/remote-ssh-mcp/releases/tag/v1.0.0)

### WSL 或 Linux 客户端

按使用的客户端选择一条命令。以下示例将主机库放在当前用户的 `~/.local/share/remote-ssh-mcp`。如果已有自定义数据目录，两个客户端都填原路径即可沿用原有主机和凭据。

```bash
codex mcp add remote-ssh --env REMOTE_SSH_MCP_DATA_DIR="$HOME/.local/share/remote-ssh-mcp" -- "$HOME/.local/bin/remote-ssh-mcp"
claude mcp add --scope user --transport stdio remote-ssh --env REMOTE_SSH_MCP_DATA_DIR="$HOME/.local/share/remote-ssh-mcp" -- "$HOME/.local/bin/remote-ssh-mcp"
```

### Windows 客户端共用 WSL 安装

在 PowerShell 中选择对应命令。将 `Ubuntu` 替换为安装该包的发行版名。如果发行版的默认用户和安装用户不同，在 `--exec` 前加上 `-u 用户名`。WSL 用户的 Bash 登录环境需要能执行 `node`。

```powershell
codex mcp add remote-ssh -- wsl.exe -d Ubuntu --exec bash -lc 'REMOTE_SSH_MCP_DATA_DIR=~/.local/share/remote-ssh-mcp exec ~/.local/bin/remote-ssh-mcp'
claude mcp add --scope user --transport stdio remote-ssh -- wsl.exe -d Ubuntu --exec bash -lc 'REMOTE_SSH_MCP_DATA_DIR=~/.local/share/remote-ssh-mcp exec ~/.local/bin/remote-ssh-mcp'
```

注册后新开客户端会话，调用 `ssh_list_hosts` 即可查看共享的主机列表。上传和下载的本地文件路径按 WSL 解释，例如 Windows 的 `D:\Temp\file.txt` 写成 `/mnt/d/Temp/file.txt`。

服务默认读取 `$XDG_DATA_HOME/remote-ssh-mcp`，没有设置 XDG 时使用 `~/.local/share/remote-ssh-mcp`。`REMOTE_SSH_MCP_DATA_DIR` 可指定绝对路径或以 `~/` 开头的路径。

## Agent skill

npm 包附带 [remote-ssh 操作指引](./skills/remote-ssh/SKILL.md)。如需在同一 WSL 用户下启用该 skill，可在安装后运行：

```bash
mkdir -p ~/.agents/skills
ln -s "$HOME/.local/lib/node_modules/remote-ssh-mcp/skills/remote-ssh" ~/.agents/skills/remote-ssh
```

## 使用

可以让任一客户端添加主机：

```json
{
  "name": "dev",
  "hostname": "192.0.2.10",
  "port": 22,
  "username": "devuser",
  "auth": "password",
  "credential": "example-password"
}
```

以上是 `ssh_add_host` 的参数示例。密钥认证使用 `auth: "key"`、`privateKeyPath`，加密私钥的口令同样放入 `credential`。保存成功后返回稳定 `host.id` 和 `host.version`；另一客户端下一次 `ssh_list_hosts` 即可发现，无需重启。已有主机的操作必须用 ID，不能用名称。

凭据直接通过 MCP 输入，默认 `remember: true`；无需额外页面或终端弹窗。本服务不在结果、错误和诊断日志回显密码，客户端仍可能保存工具输入。远端命令主动输出的内容属于命令输出，可能出现在结果及输出日志中。

`remember: false` 只在当前 MCP 连接使用。为已有主机临时设置密码不会删除已保存密码；当前 MCP 退出后，下一次连接重新使用已保存资料。临时凭据不能供另一客户端使用。

## 工具

| 工具 | 主要参数与行为 |
| --- | --- |
| `ssh_list_hosts` | 无参数；返回 ID、版本、配置、凭据是否保存、当前连接状态和工作目录 |
| `ssh_add_host` | `name, hostname, username, auth, port?, privateKeyPath?, jumpHostId?, credential?, remember?` |
| `ssh_update_host` | `hostId, expectedVersion, patch`；`null` 可清除私钥路径或跳板；认证身份变化会清除旧凭据引用，需要重新设置 |
| `ssh_delete_host` | `hostId, expectedVersion`；删除后阻止新操作，不强行终止已开始的命令 |
| `ssh_test_connection` | `hostId`；独立测试，不改变工作连接和目录 |
| `ssh_set_credentials` | `hostId, expectedVersion, kind: "login" / "sudo", credential?, reuseSshPassword?, remember?` |
| `ssh_forget_host_key` | `hostId, expectedVersion`；明确重置信任记录，需先核实服务器身份 |
| `ssh_set_workspace` | `hostId, path?`；校验并设置当前 MCP 连接中的远端目录 |
| `ssh_shell_exec` | `hostId, command, sudo?, stdin?, timeoutMs?`；默认 120 秒，0 表示不限命令执行时间 |
| `ssh_read_file` | `hostId, path, startLine?, limit?`；文本按行读取 |
| `ssh_write_file` | `hostId, path, content, overwrite?` |
| `ssh_grep` | `hostId, pattern, path?, include?, ignoreCase?, limit?`；`path` 是搜索目录，`include` 过滤文件名 |
| `ssh_glob` | `hostId, pattern, path?, limit?`；有界遍历，不递归目录符号链接 |
| `ssh_upload_file` | `hostId, localPath, remotePath, overwrite?` |
| `ssh_download_file` | `hostId, remotePath, localPath, overwrite?` |
| `ssh_reset_connection` | `hostId`；重建当前 MCP 的连接并重新校验目录 |

主机支持多级 `jumpHostId` 跳板链，拒绝循环；仍被引用的跳板不能删除。普通密码、私钥及仅要求密码的 SSH 交互认证可用；OTP、菜单式堡垒机和 SSH agent 认证不在首版范围内。

sudo 密码单独保存；可传 `kind: "sudo", reuseSshPassword: true` 明确复用当前 SSH 密码，也可直接传 `credential`。免密 sudo 不要求密码。缺少或错误凭据立即返回错误；工具不会等待本地弹窗，也不会自动重跑命令。

主机名唯一，改名保持 ID。修改或删除必须带 `expectedVersion`；冲突返回 `HOST_CONFLICT`，重新列出后再决定如何修改。地址、账号、认证或跳板配置变化，已有连接返回 `HOST_CHANGED`，使用 `ssh_reset_connection` 应用新配置。

## 生命周期与文件

- 主机档案、服务器指纹和已记住凭据跨客户端、跨进程重启保存。
- SSH 连接、每台主机的工作目录和临时凭据只存在于当前 MCP 连接。重启从远端 home 开始。单条命令里的 `cd` 不改变保存的工作目录。
- 本地相对路径按 MCP 服务的启动目录解释；上传下载推荐绝对路径。远端支持 `~`、`~/`，不支持 `~other-user`。
- 上传下载按单文件处理，支持二进制；目标是完整文件路径，父目录必须存在，覆盖须 `overwrite: true`。创建目录、移动和删除文件通过远端命令完成。
- 输出有界；较大命令输出写入本地私有临时文件，结果返回 `fullOutputPath`。临时日志不是持久任务记录，不自动过期或删除，需用户或系统清理。
- 取消和超时尽力结束前台命令。SSH 断开不代表远端已经停止，结果可能为 `outcome: "unknown"`。不得自动重放这类命令。
- 命令执行不添加本服务的逐次批准流程；Codex 和 Claude 自身的权限规则仍由客户端控制。

## 持久化与恢复

```text
remote-ssh-mcp/
  hosts.json                 # 主机、版本、登录与 sudo 凭据引用
  known-hosts.json            # 按地址与端口保存的首次信任指纹
  pending-cleanup.json        # 中断或清理失败后可回收的凭据 ID
  credentials/
    key                      # 本地自动解锁密钥
    vault.json               # AES-256-GCM 加密凭据
```

采用跨进程锁、锁内重读与原子文件替换。登录与 sudo 引用和主机版本一次提交；先写入新凭据再提交引用，最后清理旧凭据。清理未完成时结果包含 `cleanupPending: true`，后续管理操作会重试；日志会保护仍被主机引用的凭据。

备份整个数据目录，并保留匹配的 `key` 与 `vault.json`。两者同时被取得即可解密，这沿用参考包的自动解锁模式。密钥缺失、权限不正确或库损坏会明确失败，不覆盖旧库或回退到明文。此实现不承诺断电时多个文件具有数据库式事务保证。

首次连接自动记录指纹；后续不匹配则拒绝。只有核实服务器身份后才使用 `ssh_forget_host_key`，然后重连。重置信任不会重新认证其他客户端已有的连接。

## 开发与验证

在源码目录下运行以下命令。

```bash
npm ci
npm run check
npm run test:integration
npm run test:package
```

集成测试使用隔离 Docker OpenSSH 容器、临时密钥与数据目录，不使用生产主机。默认从 `test/fixture/Dockerfile` 构建；如果已有用此 fixture 构建的镜像，可设置 `REMOTE_SSH_MCP_TEST_IMAGE=<image>`，该外部镜像不会被测试清理删除。

测试覆盖两个真正的 stdio MCP 进程、共享主机、目录隔离、凭据恢复、版本冲突，以及真实 SSH/SFTP、跳板、sudo、超时、取消和网络中断。架构和上游代码来源见 [实现设计](./docs/design.md) 和 [NOTICE.md](./NOTICE.md)。

实际客户端自动验收可单独运行 `npm run test:clients`。它会调用本机 Codex 与 Claude 的模型，可能产生 API 费用；使用临时主机库和测试容器，不写入已配置的真实主机库。
