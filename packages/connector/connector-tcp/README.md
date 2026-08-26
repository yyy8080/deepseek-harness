# @deepseek-ai/dsh-connector-tcp

English | [中文](README.zh.md)

Turns a deployment's remote connector declarations into [`ctx.connectors`](../connector/README.md) registrations whose links reach a [`dsh-connector-agent`](../connector-host/README.md) over TCP. This is the package that makes the execution world live on another machine.

## Configuration

`connectors` is a list; each entry declares one target.

| Field | Meaning |
|---|---|
| `id` | Identifier sessions bind to. |
| `host` | Agent host name or address. Prefer a loopback address behind an SSH tunnel. |
| `port` | Agent TCP port. |
| `os` | Target OS family: `linux`, `macos`, or `windows`. The agent must report the same one. |
| `workdir` | Target default working directory. The agent must report the same one. |
| `tokenEnv` | Environment variable holding the shared secret. |
| `token` | Inline shared secret, for a deployment that manages its config file as one. |
| `connectTimeoutMs` | Deadline for socket connect plus handshake. Defaults to 10 seconds. |

Exactly one of `tokenEnv` and `token` is required, and the resolved secret must be non-empty; a declaration that supplies both, neither, or an unset variable fails at load. `tokenEnv` is the form to prefer, so a deployment file never carries the credential.

```yaml
- @deepseek-ai/dsh-connector-tcp:
    connectors:
      - id: build-linux
        host: 127.0.0.1
        port: 8765
        os: linux
        workdir: /srv/work
        tokenEnv: DSH_BUILD_LINUX_TOKEN
```

## Behavior

- **Declared facts are checked, not trusted** — the agent reports its OS family and working directory in the handshake, and a link whose agent contradicts the declaration is refused. A mistyped address therefore cannot silently point a session's files and commands at the wrong machine.
- **Handshake deadline** — `connectTimeoutMs` covers connect and handshake together, so a peer that accepts the socket and then says nothing fails as `CONNECTOR_UNAVAILABLE` instead of hanging the first operation.
- **One socket, many calls** — calls are correlated by client-assigned id, and an aborted call sends a `cancel` frame so the agent stops the work rather than only the waiting.
- **Process identifiers are client-assigned** — the client installs its observer before sending the spawn, so no notification for a process can arrive ahead of the observer that would have received it.
- **Losing the socket settles everything** — every call in flight rejects with `CONNECTOR_UNAVAILABLE`, a process that had not yet reported its outcome is failed, and one that had is reported as tree-exit. Later calls throw the same failure instead of hanging.

## Model Experience

Indirectly, through [`dsh-fs-connector`](../fs-connector/README.md) and [`dsh-subprocess-connector`](../subprocess-connector/README.md), which render everything that crosses this transport, and through the target description [`dsh-connector`](../connector/README.md) contributes to the system prompt.

#### KV Cache effect

No direct invalidation; the named consumers own any request-prefix changes.

## Known Limitations and Deferred Work

- **Plain TCP** — there is no TLS, no peer certificate, and no channel binding. The declaration's `host` is expected to be a loopback address behind an operator-provided tunnel for anything but a trusted private network.
- **A lost link is not re-established** — the registry drops a failed link so the next operation opens a new one, but a process that was running when the socket died is gone. Nothing resumes it.
- **No connection pooling or heartbeats** — one socket serves every session bound to the connector, and an idle socket is not probed. A silently dead peer is discovered by the next operation.
