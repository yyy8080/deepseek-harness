# @deepseek-ai/dsh-connector

English | [中文](README.zh.md)

Service Definition for the connector capability seam (`ctx.connectors`). A connector names one machine and one operating-system family; the registry holds the configured connectors, resolves which one a session runs on, and hands out the shared link its capability providers operate through. Transport packages register connectors, and [`dsh-fs-connector`](../fs-connector/README.md) plus [`dsh-subprocess-connector`](../subprocess-connector/README.md) consume the result.

## Configuration

| Field | Meaning |
|---|---|
| `default` | Connector a session runs on when its log carries no `connector/bound` event. Omit it to require every conversation to bind one explicitly. |

Resolution fails loud: a `default` no registration answers, or a session bound to an unregistered id, raises `CONNECTOR_UNKNOWN` at the operation, not silently at load, because a transport plugin may register later in the same application.

## Behavior

- **Registry** — `register(descriptor, open)` contributes one connector through `ctx.effect` and returns its disposer; a duplicate id throws, since a deployment naming two machines the same way cannot be resolved. `list`, `get`, `describe`, and `tryDescribe` read the registrations.
- **Session binding** — `bindSessionConnector(session, id)` appends one `connector/bound` event; `effectiveConnectorId(events)` folds the log back to the last binding. The session log is the store, so a binding survives restart by replay and two conversations never share a target. The event is log-only, like `sandbox/mode`: durable and replayable, never in the model transcript.
- **Resolution order** — a request naming `connectorId` outranks the calling session's binding, which outranks `default`. Naming one is for a caller that is ABOUT a connector rather than inside a conversation, such as the portal's liveness probe; a capability provider always resolves the calling session's own execution world instead.
- **Link lifetime** — `link(request)` opens the connector's link on first use and memoizes it for every later caller; a failed opening is not memoized, so the next operation retries. Disposal closes the links the registry opened, and `connector/link-opened` / `connector/link-closed` publish those transitions.
- **Target dialect** — `connectorPathModule(os)` returns Node's `win32` path module for a Windows target and `posix` otherwise. Every synchronous path computation a connector-backed provider performs runs in the target's dialect, never the harness host's.
- **Wire protocol** — [`./protocol`](src/protocol.ts) defines newline-delimited JSON frames: a `hello`/`ready` handshake carrying the protocol revision, correlated `call`/`result`/`error` frames, `cancel`, and server-initiated `event` frames for one process's output, close, failure, and tree-exit. Frames are validated on arrival and capped at 64 MiB, because a peer is remote and unauthenticated until the handshake completes. Both the agent and every client transport decode through this one module.
- **Failures** — `ConnectorError` carries `CONNECTOR_UNKNOWN` (no such connector), `CONNECTOR_UNAVAILABLE` (link cannot be opened or was lost), `CONNECTOR_PROTOCOL` (peer violated the wire contract), and `CONNECTOR_UNSUPPORTED` (the target world cannot perform the operation).

## Model Experience

### Target machine system prompt context

#### What the model sees

One `connector:target` context block, ordered at 105, naming the connector the calling session resolved to, its operating-system family, and its working directory — so the model writes that target's path syntax and commands instead of the harness host's. An assembly with no session, a binding no registration answers, and an unconfigured default all contribute nothing; the failing operation reports the missing connector with its own typed error.

##### Rendered block

```markdown
File and command operations in this session run on connector "lab-win", a Windows machine, not on the machine hosting this conversation. Use Windows path syntax and commands, and treat "C:\\work" as the working directory.
```

#### Token effect

One sentence, tens of tokens, present once per request for a session that resolves a connector. Nothing scales with the number of registered connectors: only the resolved one is described.

#### KV Cache effect

The block sits in the stable system-prompt prefix. Binding a session to a different connector rewrites it, invalidating that session's prefix once — the same cost as any other system-prompt context change.

## Known Limitations and Deferred Work

- **Rebinding mid-conversation does not migrate anything** — a second `connector/bound` event points later operations at another machine, but files already written and processes already running stay where they were. Nothing detects that the transcript now describes two worlds.
- **One link per connector, shared by every session** — sessions bound to the same connector share one transport and one target working directory. Per-session isolation on a shared target is the sandbox seam's concern, not this one.
- **No liveness probing** — a link is opened on first use and kept until disposal. A target that goes away is discovered by the next operation failing, not in advance.
