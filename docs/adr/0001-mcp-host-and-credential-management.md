---
status: accepted
---

# 通过 MCP 管理主机与录入凭据

参考包使用 Pi 的交互菜单管理主机并录入密码，而本项目面向 WSL 中的 Codex CLI 与 Claude Code。按用户明确选择，主机信息、登录密码、私钥口令和 sudo 密码均通过 MCP 工具提供，不增加独立的本地页面、交互终端或弹窗流程，以保持接入简单并尽量沿用参考包。

MCP 服务的结果、错误和诊断日志不回显这些凭据；接入客户端对工具输入的展示或留存不由本服务控制。第二轮确认的持久化策略见 [ADR-0002](./0002-shared-hosts-isolated-connections.md)。
