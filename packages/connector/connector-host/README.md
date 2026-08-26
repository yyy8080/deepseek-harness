# @deepseek-ai/dsh-connector-host

English | [中文](README.zh.md)

The target side of a connector: the execution world one machine offers, the TCP agent that serves it, and the plugin that registers the harness machine itself as an in-process connector. The world is a private Cordis application holding nothing but [`@deepseek-ai/dsh-fs-local`](../../fs/fs-local/README.md) and [`@deepseek-ai/dsh-subprocess-local`](../../subprocess/subprocess-local/README.md), projected onto the connector operation set. Reusing the shipped local providers is the point: filesystem identity, atomic publication, line-ending handling, process trees, PATH lookup, and Windows process termination keep exactly one implementation whether the agent runs beside the harness or on another machine.

## Configuration

Mounting the plugin registers this machine as a connector.

| Field | Meaning |
|---|---|
| `id` | Identifier sessions bind to. Defaults to `local`. |
| `workdir` | Absolute default working directory. Defaults to the harness process cwd. |

The `dsh-connector-agent` bin takes the same facts from its command line instead:

```
dsh-connector-agent --host 127.0.0.1 --port 8765 --workdir /srv/work --token <secret>
```

`--token` may be omitted when `DSH_CONNECTOR_TOKEN` holds the secret, which is how a deployment avoids putting it in a process listing. A missing or empty secret is refused; there is no unauthenticated mode.

## Running the agent

The agent is plain Node with no native dependency of its own, so the same command works on both target families. Install the built package on the target, then:

- **Linux/macOS** — `DSH_CONNECTOR_TOKEN=… dsh-connector-agent --workdir /srv/work`. Keep the default loopback bind and reach it with `ssh -L 8765:127.0.0.1:8765 user@target`, or run it under systemd with the token in an `EnvironmentFile`.
- **Windows** — `$env:DSH_CONNECTOR_TOKEN='…'; dsh-connector-agent --workdir C:\work`. Paths, `file:` URIs, PATHEXT lookup, and tree termination follow Windows rules because the local providers already implement them; the agent reports `windows` in its handshake so the client computes paths in the same dialect.

## Behavior

- **Handshake** — a client sends `hello` with the protocol revision and the secret; the agent answers `ready` with its own revision, OS family, and working directory, or reports the failure and closes the socket. Secrets are compared in constant time. Nothing else is accepted before the handshake completes.
- **Dispatch** — each `call` frame runs one operation against the private world under its own `AbortController`, so a `cancel` frame aborts exactly that call. Positional arguments are validated on arrival, because the peer is a wire boundary rather than a typed caller.
- **Processes** — the client assigns each process's identifier in the spawn call, so the agent can never deliver a notification before the client's observer exists. Both output streams are always delivered as base64; exit is announced only once both piped streams are finished, and tree-exit follows separately.
- **Client departure** — closing a connection aborts that client's in-flight calls and terminates the process trees it started. A client cannot leave work running on the target by disconnecting.
- **Exposure** — the token grants complete file and command access to the served world. The bin binds loopback by default and expects an operator-provided transport — an `ssh -L` tunnel or a private network — for anything wider.

## Model Experience

Indirectly, through [`dsh-fs-connector`](../fs-connector/README.md) and [`dsh-subprocess-connector`](../subprocess-connector/README.md), which render everything this machine answers, and through the target description [`dsh-connector`](../connector/README.md) contributes to the system prompt.

#### KV Cache effect

No direct invalidation; the named consumers own any request-prefix changes.

## Known Limitations and Deferred Work

- **No transport-level encryption** — frames travel in the clear over TCP. A deployment reaching beyond loopback is expected to supply the tunnel; the agent neither terminates TLS nor verifies a peer certificate.
- **One served world per agent** — the workdir and the OS family are fixed at startup. Serving several roots means running several agents.
- **No terminals** — the agent serves the filesystem and managed process trees; PTY allocation is not part of the operation set, so [`dsh-terminal-bash`](../../terminal/terminal-bash/README.md) cannot run against a connector.
- **Restart drops live processes** — process handles belong to a connection, and the agent holds no durable record of them. Restarting the agent or losing the socket ends every tree it started.
