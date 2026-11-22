# Remote SSH MCP

面向 Codex 与 Claude 的远程 SSH 工具。本文只定义领域术语，不决定具体存储或部署方式。

## Language

**主机档案（Host Profile）**：用户保存的一个 SSH 连接目标及其身份、连接资料。它不是一条正在使用的 SSH 连接。
_Avoid_: 将主机档案称为连接会话。

**共享主机库（Shared Host Registry）**：Codex 与 Claude 使用的同一组主机档案；用户在任一客户端保存的档案都属于该主机库。
_Avoid_: 两份需要用户手工同步的客户端主机列表。

**接入客户端（Client）**：用户调用远程 SSH 工具的入口，本项目的目标入口是 Codex CLI 与 Claude Code。

**登录凭据（Login Credential）**：用于登录某个主机的密码，或解锁其私钥的口令。它与服务器身份指纹、sudo 凭据是不同的资料。

**sudo 凭据（Sudo Credential）**：用于在指定主机上通过 sudo 提权的密码；它可能与登录密码相同，但用途独立。

**客户端连接上下文（Client Connection Context）**：某个接入客户端在一次 MCP 连接期间使用的 SSH 连接、各主机工作目录和临时凭据。不同客户端连接上下文相互独立。
_Avoid_: 将共享主机库或某次聊天对话等同于客户端连接上下文。

**远程工作目录（Remote Working Directory）**：某台主机在一个客户端连接上下文中用于解析相对路径的目录。同一主机可以在不同上下文中使用不同目录。

**已记住凭据（Remembered Credential）**：用户保存后可供后续客户端连接继续使用的登录凭据或 sudo 凭据。
_Avoid_: 临时凭据。

**临时凭据（Temporary Credential）**：只在提供它的客户端连接上下文中可用的凭据；该上下文结束后不再可用。
_Avoid_: 已记住凭据。

**远程命令结果（Remote Command Outcome）**：本工具能够确认的某条命令在远端的完成情况。连接丢失本身不能证明命令已经停止、成功或失败。
