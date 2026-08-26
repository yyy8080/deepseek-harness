# connector/ — connector execution-world family

English | [中文](README.zh.md)

Detaches the execution world from the machine that runs the agent. The harness process keeps the model loop, tool orchestration, session log, and approvals; a connector names one other machine and answers the filesystem and subprocess seams there. A conversation binds a connector, and every file read, write, edit, and command in that conversation runs on the bound machine.

| Package | ctx key | Role |
|---|---|---|
| [`connector`](connector/README.md) (`@deepseek-ai/dsh-connector`) | `ctx.connectors` | Service Definition: the registry of configured targets, the per-session binding that selects one, the shared link each provider operates through, and the wire protocol both halves speak |
| [`connector-host`](connector-host/README.md) (`@deepseek-ai/dsh-connector-host`) | — | The target side: the execution world one agent serves, its TCP server, the `dsh-connector-agent` binary, and an in-process `local` connector for a same-machine deployment |
| [`connector-tcp`](connector-tcp/README.md) (`@deepseek-ai/dsh-connector-tcp`) | — | Turns a deployment's remote connector declarations into registry entries whose links reach a `dsh-connector-agent` over TCP |
| [`fs-connector`](fs-connector/README.md) (`@deepseek-ai/dsh-fs-connector`) | `ctx.fs` | Implements the filesystem seam over the calling session's connector, in that target's path dialect |
| [`subprocess-connector`](subprocess-connector/README.md) (`@deepseek-ai/dsh-subprocess-connector`) | `ctx.subprocess` | Implements executable lookup and managed process trees over the calling session's connector |

Mounting `dsh-fs-connector` and `dsh-subprocess-connector` in place of the local providers moves the whole execution world at once. The provider-neutral consumers above them — [`dsh-tool-fs`](../fs/tool-fs/README.md), [`dsh-bash-local`](../shell/bash-local/README.md), [`dsh-lsp-stdio`](../lsp/lsp-stdio/README.md) — need no connector-specific fork, because they already state every operation in terms of `ctx.fs` and `ctx.subprocess`. This is the same composition the [portable execution-world decision](../../.agents/notes/implemented/architecture/2026-07-28-portable-execution-world-consumers.md) describes and [`e2b/`](../e2b/README.md) first proved; a connector differs in that the target is an ordinary Linux, macOS, or Windows machine the operator already has, reached over a protocol this repository owns on both sides.

The [connector execution-world decision](../../.agents/notes/implemented/architecture/2026-08-26-connector-execution-world.md) records why the binding is a session event, why the target side reuses the shipped local providers, and which alternatives were rejected.
