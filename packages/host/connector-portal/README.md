# @deepseek-ai/dsh-host-connector-portal

English | [中文](README.zh.md)

The web entry point for connectors: the routes that hand a user a runnable start script, accept the agent that script launches, and register the machine behind it in [`ctx.connectors`](../../connector/connector/README.md). A deployment that already publishes an HTTP origin needs nothing else — the target machine keeps no inbound port, no tunnel, and no YAML, because the agent dials the deployment rather than the other way round.

The package is one plugin rather than three because enrollment, pack rendering, and attachment are the same fact seen at three moments: the secret minted for a download is the secret the agent presents, and the enrollment it names is the connector id a session binds to. Splitting them would publish that secret across package interfaces for no separate evolution.

## Configuration

| Field | Meaning |
|---|---|
| `basePath` | Absolute route prefix, without a trailing slash. Defaults to `/connector`. |
| `packTtlMs` | How long a freshly issued pack stays downloadable. Defaults to 30 minutes. |
| `maxConnectors` | How many targets may be attached at once. Defaults to `8`. |
| `publicOrigin` | Origin the generated packs dial back to. Left unset, each download derives it from its own request, which is what an ordinary reverse proxy wants; set it when the proxy rewrites the `Host` it forwards. |
| `agentProgramPath` | Absolute path of the single-file agent program `<basePath>/agent.mjs` serves. Defaults to the bundle [`dsh-connector-host`](../../connector/connector-host/README.md) ships, which `pnpm run build` produces. |

## Routes and Remote

| Path | Purpose |
|---|---|
| `GET <basePath>/pack/<enrollmentId>` | Renders that enrollment's start script — `dsh-connector.sh` or `dsh-connector.ps1` — carrying this deployment's origin and the enrollment secret. |
| `GET <basePath>/agent.mjs` | Serves the bundled agent program. It holds no secret and is identical for every target; the pack fetches it. Answers `503` when the build carries no bundle. |
| `UPGRADE <basePath>/attach` | Accepts an agent's reversed connection over the `dsh-connector` upgrade protocol. |

The `connectorPortal` Remote answers `issue` (mint an enrollment and describe its download), `list` (the ledger the Settings page renders), and `revoke` (discard an enrollment, disconnecting its agent). The browser half is [`client-ui-settings-connectors`](../../client/ui-settings-connectors/README.md).

## Behavior

- **Enrollment lifetimes** — the pack download is short-lived because the file carries the secret and a stale link in a shell history is the realistic leak. The attachment it authorizes is not: a target left running survives a sleeping laptop and a moving network without a new download. `issued`, `downloaded`, `attached`, and `expired` are the four words the ledger reports.
- **Attach admission** — the token names its enrollment and carries a 24-byte secret compared in constant time. A re-dial of an already-attached enrollment replaces its own connection instead of counting against `maxConnectors`, because the previous socket is one the target itself gave up on.
- **Adoption races** — each admitted attach owns a generation. An adoption whose handshake finishes after a later dial was admitted, or after the enrollment was revoked, closes its own link rather than taking the slot, so the newest agent always owns the registration.
- **Teardown** — unmounting the plugin releases every attachment, including a target that attached but was never used by a session and whose link the registry therefore never opened.
- **Restart** — records live in memory. A harness restart drops them, and each agent's retry loop then reports a refused attachment until the user issues a new pack, rather than a target silently serving a deployment that no longer knows why.

## Threat model

Possession of a pack is complete read, write, and command access to the machine that runs it, exercised by whoever controls the deployment. Two consequences follow.

- **The download is the credential.** The unguessable enrollment id in the path is the only thing gating `<basePath>/pack/<id>`, so the Remote that mints it is the authenticated surface. A deployment that publishes the portal must keep its browser surface authenticated — this repository's reference deployment does so with reverse-proxy authentication in front of everything — because anyone who can call `issue` can enroll a machine.
- **The target trusts the deployment.** The generated script says so in its own header, in the file the user reads before running it. Over `http:` both the token and every frame travel in the clear; a deployment reachable beyond a private network is expected to terminate TLS in front of the portal.

## Model Experience

Indirectly. An attached target becomes a connector like any other, so the description [`dsh-connector`](../../connector/connector/README.md) contributes to the system prompt and the operations [`dsh-fs-connector`](../../connector/fs-connector/README.md) and [`dsh-subprocess-connector`](../../connector/subprocess-connector/README.md) render are what the model sees. This package contributes no tool and no prompt text of its own.

#### KV Cache effect

None directly; binding a session to a newly attached target changes the prefix the connector description owns.

## Known Limitations and Deferred Work

- **Session binding stays outside the portal** — the page reports the connector id of every attached machine, and a session reaches it through an agent preset that mounts the connector-backed filesystem and subprocess providers. Choosing that target per conversation from the browser is not built.
- **No durable ledger** — enrollments do not survive a harness restart, so a long-lived target needs a fresh pack after one.
- **One pack per enrollment family** — the script is generated for `linux`, `macos`, or `windows`; there is no signed installer, no service unit, and no unattended-update path.
- **No per-enrollment scope** — an attached target serves its whole working directory to any session that binds to it; the portal carries no narrower grant.
