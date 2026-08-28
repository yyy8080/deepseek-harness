# @deepseek-ai/dsh-connector-host

English | [中文](README.zh.md)

The target side of a connector: the execution world one machine offers, the TCP agent that serves it, and the plugin that registers the harness machine itself as an in-process connector. The world is a private Cordis application holding nothing but [`@deepseek-ai/dsh-fs-local`](../../fs/fs-local/README.md) and [`@deepseek-ai/dsh-subprocess-local`](../../subprocess/subprocess-local/README.md), projected onto the connector operation set. Reusing the shipped local providers is the point: filesystem identity, atomic publication, line-ending handling, process trees, PATH lookup, and Windows process termination keep exactly one implementation whether the agent runs beside the harness or on another machine.

## Configuration

Mounting the plugin registers this machine as a connector.

| Field | Meaning |
|---|---|
| `id` | Identifier sessions bind to. Defaults to `local`. |
| `workdir` | Absolute default working directory. Defaults to the harness process cwd. |

The `dsh-connector-agent` bin takes the same facts from its command line instead, in either of two modes:

```
dsh-connector-agent --host 127.0.0.1 --port 8765 --workdir /srv/work --token <secret>
dsh-connector-agent --attach https://harness.example/connector/attach --label laptop --workdir /srv/work
```

`--token` may be omitted when `DSH_CONNECTOR_TOKEN` holds the secret, which is how a deployment avoids putting it in a process listing, and `--attach` may be omitted when `DSH_CONNECTOR_ATTACH` names the endpoint. A missing or empty secret is refused; there is no unauthenticated mode. `--host` and `--port` describe a bind and `--label` names the machine to a deployment, so combining either with the other mode is refused at parse time rather than silently ignored.

## Running the agent

The agent is plain Node with no native dependency of its own, so the same command works on both target families. Install the built package on the target, or fetch the single-file bundle a deployment serves (see below), then:

- **Linux/macOS** — `DSH_CONNECTOR_TOKEN=… dsh-connector-agent --workdir /srv/work`. Keep the default loopback bind and reach it with `ssh -L 8765:127.0.0.1:8765 user@target`, or run it under systemd with the token in an `EnvironmentFile`.
- **Windows** — `$env:DSH_CONNECTOR_TOKEN='…'; dsh-connector-agent --workdir C:\work`. Paths, `file:` URIs, PATHEXT lookup, and tree termination follow Windows rules because the local providers already implement them; the agent reports `windows` in its handshake so the client computes paths in the same dialect.

## Attach mode

Listen mode asks the target to be reachable. Attach mode inverts that: the agent dials the deployment's attach endpoint, upgrades the connection to the `dsh-connector` protocol, and is served over the socket it opened. The target then needs no inbound port, no tunnel, and no name in DNS — only outbound HTTP to the deployment. This is what [`dsh-host-connector-portal`](../../host/connector-portal/README.md) generates start scripts for.

The protocol does not change. The agent presents its token in the upgrade request, so the deployment knows which enrollment dialled in before it accepts a byte of protocol; the deployment then sends the same `hello` it would over a dialled socket, carrying the same secret, and the agent answers `ready`. Both directions stay authenticated, and the served world is identical either way. Refusals are read from the HTTP status: the agent reports the deployment's reason and retries on a fixed delay, so a revoked enrollment or a restarted harness is visible in the agent's own output rather than silent.

## The bundled agent

`pnpm run build` also emits `lib/agent-bundle.js`, exported as `@deepseek-ai/dsh-connector-host/agent-bundle`: one file that runs under plain Node with no `node_modules` beside it. It exists so a deployment can serve the agent over HTTP to a machine that has Node and nothing else.

Native modules cannot travel in a single file, so the bundle resolves [`node-pty`](https://www.npmjs.com/package/node-pty) and [`koffi`](https://www.npmjs.com/package/koffi) to build-time stubs that throw when called. The consequence is exact: the bundle serves the filesystem and one-shot commands in full, and PTY allocation — which the operation set does not carry anyway — is unavailable, as is the Windows process inspector that only terminal spawning uses. A target needing those installs the package from a registry instead.

## Behavior

- **Handshake** — a client sends `hello` with the protocol revision and the secret; the agent answers `ready` with its own revision, OS family, and working directory, or reports the failure and closes the socket. Secrets are compared in constant time. Nothing else is accepted before the handshake completes.
- **Dispatch** — each `call` frame runs one operation against the private world under its own `AbortController`, so a `cancel` frame aborts exactly that call. Positional arguments are validated on arrival, because the peer is a wire boundary rather than a typed caller.
- **Processes** — the client assigns each process's identifier in the spawn call, so the agent can never deliver a notification before the client's observer exists. Both output streams are always delivered as base64; exit is announced only once both piped streams are finished, and tree-exit follows separately.
- **Client departure** — closing a connection aborts that client's in-flight calls and terminates the process trees it started. A client cannot leave work running on the target by disconnecting.
- **Exposure** — the token grants complete file and command access to the served world. In listen mode the bin binds loopback by default and expects an operator-provided transport — an `ssh -L` tunnel or a private network — for anything wider; nothing widens that bind implicitly. In attach mode the target opens the connection itself, so the exposure it accepts is one named deployment rather than a port.

## Model Experience

Indirectly, through [`dsh-fs-connector`](../fs-connector/README.md) and [`dsh-subprocess-connector`](../subprocess-connector/README.md), which render everything this machine answers, and through the target description [`dsh-connector`](../connector/README.md) contributes to the system prompt.

#### KV Cache effect

No direct invalidation; the named consumers own any request-prefix changes.

## Known Limitations and Deferred Work

- **No transport-level encryption** — frames travel in the clear over TCP. A deployment reaching beyond loopback is expected to supply the tunnel; the agent neither terminates TLS nor verifies a peer certificate.
- **One served world per agent** — the workdir and the OS family are fixed at startup. Serving several roots means running several agents.
- **No terminals** — the agent serves the filesystem and managed process trees; PTY allocation is not part of the operation set, so [`dsh-terminal-bash`](../../terminal/terminal-bash/README.md) cannot run against a connector.
- **Restart drops live processes** — process handles belong to a connection, and the agent holds no durable record of them. Restarting the agent or losing the socket ends every tree it started.
