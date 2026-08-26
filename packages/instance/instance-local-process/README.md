# @deepseek-ai/dsh-instance-local-process

English | [中文](README.zh.md)

Local-process Service Provider for the [instance seam](../instance/README.md). Every instance is one child harness process with its own `DSH_HOME`, its own workspace directory, and its own loopback `/api` server, so conversations placed in different instances share no session store, no settings, and no shell state.

## Contract

- `command` and `args` must boot a harness profile that serves `/api` on loopback and performs the seam's endpoint handshake. `@deepseek-ai/dsh-worker` is that profile; nothing here assumes it, so a deployment can substitute its own.
- Each instance owns `<root>/<instanceId>/`, holding `home` (the worker's `DSH_HOME`), `workspace` (its working directory), and `endpoint.json` (the handshake file). The tree is removed and recreated on every start, so a stale endpoint can never be read as a live one. Directories are created owner-only.
- The worker is spawned through `ctx.subprocess`, so it starts from the seam's scrubbed environment. Credentials reach it only through `env` (explicit values) or `forwardEnv` (names copied from the control plane's own environment); a `forwardEnv` name that is unset in the parent is skipped rather than forwarded empty.
- `DSH_HOME` and the handshake variable are set by this provider and cannot be overridden by `env`.
- Readiness is the endpoint file, not the process: `start` resolves when the file names an origin, and rejects when the worker exits first, the registry cancels, or `readyTimeoutMs` passes. A rejected start reaps the worker it spawned before it rethrows.
- `stop` runs the subprocess seam's `SIGTERM → stopGraceMs → SIGKILL` escalation over the worker's whole process tree and resolves only after the tree exits. `removeStateOnStop` then deletes the instance tree; left off, the worker's session logs survive for inspection.

## Model Experience

None, as the provider only supervises child harness processes; the worker bundle each one boots owns every prompt, tool, and session event a model there sees.

#### KV Cache effect

None; this package neither assembles nor sends a provider request.

## Known Limitations and Deferred Work

- Isolation is filesystem- and process-scoped only. A worker shares the kernel, network namespace, and user account of the control plane, so this provider is a development and single-tenant answer, not a security boundary. A container or remote-sandbox provider behind the same seam is the multi-tenant answer.
- Worker output is inherited, so a worker's diagnostics land on the control plane's own streams unlabelled. Attributing a line to the instance that wrote it needs a stream-ownership decision the seam does not yet make.
- Nothing bounds concurrent instances, and each one is a full harness process. A control plane that creates instances per conversation must impose its own ceiling.
- A control-plane crash orphans running workers: they are only reachable through this process's handles, and nothing re-adopts them on the next boot.
