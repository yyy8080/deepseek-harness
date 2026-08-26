# @deepseek-ai/dsh-subprocess-connector

English | [中文](README.zh.md)

Connector implementation of the [`@deepseek-ai/dsh-subprocess`](../../subprocess/subprocess/README.md) provider contract. It has no config: mount [`@deepseek-ai/dsh-connector`](../connector/README.md) and at least one transport, then this service in place of `dsh-subprocess-local`. Executable lookup and managed process trees run on the machine the calling session is bound to, while stdio dispositions, collection limits, and cancellation stay in the harness process where their consumers live.

## Behavior

- **Session selects the machine** — the calling session comes from the initiating-agent scope, which is the only ambient carrier the subprocess seam exposes: its methods take specs, not sessions. An operation outside any agent resolves the deployment default instead.
- **Asynchronous startup behind a synchronous seam** — the seam publishes a handle synchronously but a remote spawn cannot, so `pid`, stdin writes, and termination all queue behind the publishing round-trip. `pid` reads `-1` until the target answers, and a spawn the target refuses is reported through the handle's `done`, not by a throw from `spawn`. This is the same asynchronous-startup arrangement the E2B provider documents.
- **Output** — the target always delivers both streams, and this side routes them by the spec's dispositions: a raw readable for `pipe`, the harness's own descriptor for `inherit`, and a bounded tail-keep collector otherwise. Collection reports its byte counts and whether the tail lost anything.
- **Process lifetime** — `terminate` starts the target's tree-scoped SIGTERM/grace/SIGKILL escalation, and `waitForExit` resolves when the whole tree is gone on that machine, not when the direct child closed. Disposal terminates every live handle and waits for its tree, so unmounting the provider leaves nothing running on the target.
- **Cancellation** — an abort signal on the spec terminates the remote tree. A signal that has already fired terminates it as soon as it exists.

## Model Experience

Indirectly, through [`dsh-tool-bash`](../../shell/tool-bash/README.md) and the other subprocess consumers, which render remote command output and exit facts while the connector and its transport remain internal. The model is told which machine its commands run on by the target description [`dsh-connector`](../connector/README.md) contributes to the system prompt.

#### KV Cache effect

No direct invalidation; the named consumers own any request-prefix changes.

## Known Limitations and Deferred Work

- **No terminals** — `spawnTerminal` rejects with `CONNECTOR_UNSUPPORTED`. PTY allocation is not part of the connector operation set, so a persistent-shell capability must be mounted on a same-host subprocess provider.
- **No spill file** — collected output keeps a bounded in-memory tail on this side and reports truncation, but there is no complete-stream file to point the model at, because such a file would have to live on the target and be fetched back. A truncated stream is therefore unrecoverable.
- **`pid` is not immediately available** — a caller that reads `pid` in the same tick as `spawn` sees `-1`. Consumers that need the real identifier must await the first operation on the handle.
- **cwd is not resolved for the caller** — the spec's `cwd` is passed to the target verbatim, so it must already be an absolute path in the target's world. Callers obtain one through `ctx.fs.processPath`, which the connector filesystem provider answers in the same dialect.
