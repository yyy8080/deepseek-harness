# connector/ — connector 执行世界家族

[English](README.md) | 中文

把执行世界与运行 agent（智能体）的机器解耦。harness 进程保留模型循环、工具编排、会话日志和审批；一个 connector（连接器）指向另一台机器，并在那里应答文件系统与子进程 seam。一次会话绑定一个 connector，该会话中的所有文件读取、写入、编辑和命令都在被绑定的机器上运行。

| 包（package） | ctx 键 | 职责 |
|---|---|---|
| [`connector`](connector/README.zh.md)（`@deepseek-ai/dsh-connector`） | `ctx.connectors` | Service Definition：已配置目标的注册表、选中其一的会话级绑定、各提供方共用的链路，以及两端共同遵循的 wire 协议 |
| [`connector-host`](connector-host/README.zh.md)（`@deepseek-ai/dsh-connector-host`） | — | 目标端：一个 agent 所服务的执行世界、其 TCP 服务器、`dsh-connector-agent` 可执行文件，以及供同机部署使用的进程内 `local` connector |
| [`connector-tcp`](connector-tcp/README.zh.md)（`@deepseek-ai/dsh-connector-tcp`） | — | 把部署声明的远程 connector 变成注册表条目，其链路通过 TCP 连接到 `dsh-connector-agent` |
| [`fs-connector`](fs-connector/README.zh.md)（`@deepseek-ai/dsh-fs-connector`） | `ctx.fs` | 在调用会话所绑定的 connector 上实现文件系统 seam，并使用该目标的路径方言 |
| [`subprocess-connector`](subprocess-connector/README.zh.md)（`@deepseek-ai/dsh-subprocess-connector`） | `ctx.subprocess` | 在调用会话所绑定的 connector 上实现可执行文件查找与受管进程树 |

用 `dsh-fs-connector` 和 `dsh-subprocess-connector` 替换本地提供方，会一次性迁移整个执行世界。它们之上与提供方无关的消费方——[`dsh-tool-fs`](../fs/tool-fs/README.zh.md)、[`dsh-bash-local`](../shell/bash-local/README.zh.md)、[`dsh-lsp-stdio`](../lsp/lsp-stdio/README.zh.md)——无需 connector 专用 fork，因为它们的所有操作本就以 `ctx.fs` 和 `ctx.subprocess` 表述。这与[可移植执行世界决策](../../.agents/notes/implemented/architecture/2026-07-28-portable-execution-world-consumers.zh.md)所描述、并由 [`e2b/`](../e2b/README.zh.md) 首次验证的组合方式相同；connector 的差别在于目标是运维方已有的普通 Linux、macOS 或 Windows 机器，通过本仓库同时拥有两端实现的协议访问。

上面两个包访问的都是运维方事先配置好的目标。若部署希望由用户自己在浏览器里登记自己的机器，则挂载 [`dsh-host-connector-portal`](../host/connector-portal/README.zh.md)：它提供一段生成的启动脚本，agent 以 `dsh-connector-host` 的 attach 模式通过 HTTP 升级回拨，其背后的机器随即加入同一份注册表。

[connector 执行世界决策](../../.agents/notes/implemented/architecture/2026-08-26-connector-execution-world.zh.md)记录了为什么绑定是一个会话事件、为什么目标端复用已发布的本地提供方，以及哪些备选方案被否决；[连接器下载入口决策](../../.agents/notes/implemented/architecture/2026-08-26-connector-download-portal.zh.md)记录了反向接入与单包入口的取舍。
