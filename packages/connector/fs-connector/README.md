# @deepseek-ai/dsh-fs-connector

English | [中文](README.zh.md)

Connector implementation of the [`@deepseek-ai/dsh-fs`](../../fs/fs/README.md) provider contract. It has no config: mount [`@deepseek-ai/dsh-connector`](../connector/README.md) and at least one transport, then this service in place of `dsh-fs-local`. Every operation runs on the machine the calling session is bound to, so file tools observe the same world as the commands [`dsh-subprocess-connector`](../subprocess-connector/README.md) runs there.

## Behavior

- **Session selects the machine** — the calling session comes from the initiating-agent scope, which is the only ambient carrier the filesystem seam exposes: its methods take targets, not sessions. An operation outside any agent resolves the deployment default instead.
- **Target-dialect path computation** — `processPath`, `fileUrl`, and `contains` stay synchronous and never cross the link. The connector's OS family selects `posix` or `win32`, so a Linux harness driving a Windows target produces `file:///C:/…` URIs and Windows containment rules rather than the host's. `pathToFileURL` is unusable here because it always encodes for the host platform.
- **Remote identity and metadata** — `resolve`, `stat`, `lstat`, and `listDir` forward to the target's local filesystem provider, so canonical identity, symbolic-link handling, and version opacity are exactly the ones `dsh-fs-local` defines on that machine.
- **Reads** — `readText` and `readBytes` transfer the whole file in one frame; `readBytes` is capped by `maxBytes` on the target, before any content crosses the link. Binary rejection and UTF-8 validation happen on the target, so the failure the model sees is the same one a local read would produce.
- **Mutations** — `writeText` and `editText` carry their write intent and version guard to the target and are published atomically there. Guard failures come back as the same `FsError` codes a local write raises.
- **Cancellation and failures** — an abort signal sends a `cancel` frame so the target stops the work, not just the waiting. `FsError` codes are rebuilt on this side from the wire, so a not-found or permission failure stays routable instead of collapsing into a transport error.

## Model Experience

Indirectly, through [`dsh-tool-fs`](../../fs/tool-fs/README.md), which renders remote content, directory results, mutation acknowledgements, and provider errors while the connector and its transport remain internal. The model is told which machine it is operating on by the target description [`dsh-connector`](../connector/README.md) contributes to the system prompt.

#### KV Cache effect

No direct invalidation; the named consumer owns any request-prefix changes.

## Known Limitations and Deferred Work

- **Streaming is not incremental** — `streamText` reads the whole file in one frame and yields it as a single chunk. Consumers keep their incremental interface, but a large file is buffered whole in both processes.
- **No host synchronization** — the target's workdir is whatever is already on that machine. Local files are neither uploaded nor reflected back.
- **Mutation coordination is target-process-local** — guards detect changes the target's filesystem represents, but another client of the same agent, or anything else on that machine, can still race a replacement.
- **Whole-file mutation costs** — overwrite diffs and literal edits read complete files into the target's memory and cross the link whole, and every operation pays one round-trip.
