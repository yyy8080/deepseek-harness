# @deepseek-ai/dsh-host-connector-portal

English | [中文](README.zh.md)

The web entry point for connectors: the routes that hand a user a runnable start script, accept the agent that script launches, and register the machine behind it in [`ctx.connectors`](../../connector/connector/README.md). A deployment that already publishes an HTTP origin needs nothing else — the target machine keeps no inbound port, no tunnel, and no YAML, because the agent dials the deployment rather than the other way round.

The package is one plugin rather than three because enrollment, pack rendering, and attachment are the same fact seen at three moments: the secret minted for a download is the secret the agent presents, and the enrollment it names is the connector id a session binds to. Splitting them would publish that secret across package interfaces for no separate evolution.

## Configuration

| Field | Meaning |
|---|---|
| `basePath` | Absolute route prefix, without a trailing slash. Defaults to `/connector`. |
| `packTtlMs` | How long a freshly issued pack stays downloadable, in milliseconds. `0` (the default) leaves the download open until the enrollment is revoked. It gates the download of the script file only; the reconnect credential the pack carries never expires either way. |
| `maxConnectors` | How many targets may be attached at once. Defaults to `8`. |
| `storePath` | Absolute path of the JSON file the reconnect-credential ledger is persisted to. Left unset, it lives at `connectors/enrollments.json` under the harness home, so enrollments survive a restart or plugin reload and an agent re-dials with the same secret. |
| `dshHome` | Harness home the credential store lives under when `storePath` is omitted. Defaults to `$DSH_HOME` or `~/.dsh`. |
| `publicOrigin` | Origin the generated packs dial back to. Left unset, each download derives it from its own request, which is what an ordinary reverse proxy wants; set it when the proxy rewrites the `Host` it forwards. |
| `agentProgramPath` | Absolute path of the single-file agent program `<basePath>/agent.mjs` serves. Defaults to the bundle [`dsh-connector-host`](../../connector/connector-host/README.md) ships, which `pnpm run build` produces. |
| `chatPreset` | Agent preset a conversation started from the Connectors page is composed from. Defaults to `connector`. |
| `probeTimeoutMs` | How long one liveness probe waits for the target to answer. Defaults to 10 seconds. |

## Routes and Remote

| Path | Purpose |
|---|---|
| `GET <basePath>/pack/<enrollmentId>` | Renders that enrollment's start script — `dsh-connector.sh` or `dsh-connector.ps1` — carrying this deployment's origin and the enrollment secret. |
| `GET <basePath>/agent.mjs` | Serves the bundled agent program. It holds no secret and is identical for every target; the pack fetches it. Answers `503` when the build carries no bundle. |
| `UPGRADE <basePath>/attach` | Accepts an agent's reversed connection over the `dsh-connector` upgrade protocol. An ordinary request to the same path answers `426 Upgrade Required` naming the stripped upgrade, never `404`. |

The `connectorPortal` Remote answers `issue` (mint an enrollment, persist it, and describe its download), `list` (the ledger the Settings page renders, plus whether a conversation can be started on a machine in it), `probe` (one live round trip to an attached machine), and `revoke` (discard an enrollment, persist the smaller set, and disconnect its agent). The browser half is [`client-ui-settings-connectors`](../../client/ui-settings-connectors/README.md).

## Behavior

- **Enrollment lifetimes** — an enrollment mints a per-machine reconnect credential that never expires: a target left running reconnects with the same secret across a sleeping laptop, a moving network, a harness restart, and a plugin reload, until the user removes it. The pack *download* is the separable part — the file carries the secret, so a deployment may close its window with `packTtlMs`, and a closed window never affects reconnection. `issued`, `downloaded`, and `attached` are the three words the ledger reports; a machine credential is never "expired", it is present until revoked.
- **Attach admission** — the token names its enrollment and carries a 24-byte secret compared in constant time. A re-dial of an already-attached enrollment replaces its own connection instead of counting against `maxConnectors`, because the previous socket is one the target itself gave up on.
- **Dials that lost their upgrade** — `Upgrade` and `Connection` are hop-by-hop headers, so an intercepting proxy on plain HTTP is free to drop them, and the agent's dial then arrives as an ordinary `GET` that node never raises an upgrade for. The path answers `426` with that diagnosis and the remedy — dial an `https` origin, where the connection is tunnelled end to end — short enough that the agent's own refusal report carries all of it. A deployment published on `http:` behind such a network sees the endpoint as missing otherwise.
- **Adoption races** — each admitted attach owns a generation. An adoption whose handshake finishes after a later dial was admitted, or after the enrollment was revoked, closes its own link rather than taking the slot, so the newest agent always owns the registration.
- **Liveness** — `probe` resolves and stats the attached machine's own working directory across its live link, and reports the round trip's latency, the path the TARGET resolved, and whether that path is still a directory there. The ledger's `attached` status records the last completed handshake, which a suspended, killed, or partitioned target still carries, so the two answers differ exactly when it matters. An aborted connector call does not complete — the transport tells the target to cancel and keeps waiting for an answer the target never sends — so the portal enforces `probeTimeoutMs` itself and reports `link-failed` rather than hanging.
- **Chat availability** — `list` reports whether this deployment can start a connector-bound conversation at all. It reads `chatPreset` out of the roster on every call, so a preset authored or removed while the process runs changes the answer, and refuses with `no-preset-roster`, `preset-missing`, or `preset-not-connector-backed` when the named composition would run the conversation on this machine instead of the target.
- **Teardown** — unmounting the plugin releases every attachment, including a target that attached but was never used by a session and whose link the registry therefore never opened.
- **Restart and reload** — the credential set is durable. It is persisted to `storePath` on every `issue` and `revoke` through an atomic rename behind a cross-process writer lock, and restored synchronously before any route answers. A harness restart or plugin reload drops only the live socket, which no process can carry; each agent's retry loop re-dials and is admitted with the same secret once the deployment is back up. A store file the build cannot read — corrupt bytes or an unknown version — fails the plugin loud rather than starting empty and silently refusing every enrolled machine.

## Threat model

Possession of a pack is complete read, write, and command access to the machine that runs it, exercised by whoever controls the deployment. Two consequences follow.

- **The download is the credential.** The unguessable enrollment id in the path is the only thing gating `<basePath>/pack/<id>`, so the Remote that mints it is the authenticated surface. A deployment that publishes the portal must keep its browser surface authenticated — this repository's reference deployment does so with reverse-proxy authentication in front of everything — because anyone who can call `issue` can enroll a machine.
- **The reconnect credential is long-lived by design.** The secret in a pack is a standing remote read/write/command capability over the machine that ran it — it does not expire, so a leaked pack or a compromised target stays usable until the enrollment is removed. Each machine carries its own 24-byte secret rather than a shared deployment key, so removing one machine (Settings → Connectors → 移除, the `revoke` Remote) revokes exactly that machine: its socket is dropped and its id is refused on every later dial. Revocation, not expiry, is the control; a deployment that wants a bounded download window sets `packTtlMs`, which narrows only how long the script file can be re-fetched.
- **The credential set is stored at rest.** `storePath` holds every machine's secret as owner-only JSON (`0600` under a `0700` directory). It is as sensitive as the harness home it lives in; a reader of that file can impersonate every enrolled machine's dial-in.
- **The target trusts the deployment.** The generated script says so in its own header, in the file the user reads before running it. Over `http:` both the token and every frame travel in the clear; a deployment reachable beyond a private network is expected to terminate TLS in front of the portal.

## Model Experience

Indirectly, through [`dsh-connector`](../../connector/connector/README.md), whose target description an attached machine joins, and the connector-backed providers that render every operation against it.

#### KV Cache effect

None directly; binding a session to a newly attached target changes the prefix the connector description owns.

## Known Limitations and Deferred Work

- **The probe measures the link, not the machine** — a completed `resolve`/`stat` proves the agent process is answering and its filesystem is readable. It says nothing about the target's load, disk, or whether a command would succeed there.
- **Chat availability is judged from the composition text** — a preset counts as connector-backed when it names the `@deepseek-ai/dsh-fs-connector` row. A preset that mounts the row behind a condition the portal cannot evaluate reads as ready and fails at the first tool call instead.
- **A reconnect credential does not expire on its own** — an enrollment stays a live remote-execution capability until the user removes it. There is no rotation and no per-machine time limit; a deployment's only levers are revocation and, for the download window alone, `packTtlMs`. This is the point of the feature — a target reconnects unattended — but it means an unremoved enrollment is an unbounded grant.
- **The live socket does not survive a restart, only the credential does** — a restart or plugin reload drops every attachment and each agent re-dials on its retry-loop cadence, so there is a reconnection gap rather than an unbroken link. A deployment that pins an attached machine in its composition (`connectors.default`) still reloads this plugin and drops the live socket the id names; the enrollment survives and the agent re-attaches, but a session bound in the same reload window sees the machine briefly offline.
- **One pack per enrollment family** — the script is generated for `linux`, `macos`, or `windows`; there is no signed installer, no service unit, and no unattended-update path.
- **No per-enrollment scope** — an attached target serves its whole working directory to any session that binds to it; the portal carries no narrower grant.
