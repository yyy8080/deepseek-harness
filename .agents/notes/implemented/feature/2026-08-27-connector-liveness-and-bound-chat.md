# Agent Note: Proving a connector is alive, and starting a conversation on it

Status: implemented

English | [中文](2026-08-27-connector-liveness-and-bound-chat.zh.md)

## Problem

The [download portal](../architecture/2026-08-26-connector-download-portal.md) got a machine enrolled and attached, and the Connectors page named it. It could not answer either question a user has next.

**Is the link alive?** The page showed `attached` — a fact recorded when the agent's upgrade handshake completed, possibly hours earlier. A laptop that slept, a target whose process was killed, a network that dropped without closing the socket: all three still read `attached` until the transport happened to notice. A status that reports the last event rather than the current world is worse than no status, because a user acts on it.

**Can I use it?** Binding a session to a connector needed an agent preset that mounts `dsh-fs-connector` and `dsh-subprocess-connector`, and a `connector/bound` event on the session. Neither was reachable from a browser: the deployment shipped no such preset, and `session.create` had no way to name a connector. The portal note deferred exactly this.

## Decision

Two Remote calls and one shipped preset, with a loud refusal on every path where the answer would otherwise be a guess.

### Liveness is a round trip, never a status field

`connectorPortal.probe({ enrollmentId })` resolves the attachment's own `workdir` over the live link and stats the result, then reports `latencyMs`, the path the **target** resolved, and whether it is still a directory. Two calls rather than one: `resolve` alone is answerable from a path string, while `stat` forces the target to touch its filesystem, which is the capability a caller is really asking about. The workdir is the argument because it is a path the target itself declared at attach time, so the probe needs no input from the user and cannot fail for naming something that was never there.

A `ConnectorProbeReport` is a discriminated result, not a thrown error: `alive: true` with the measurements, or `alive: false` with one of `unknown-enrollment`, `not-attached`, or `link-failed` plus a message naming the next action. `not-attached` is answered from the ledger without touching the transport, since there is nothing to probe.

The portal enforces its own deadline with `Promise.race` against an abort-driven rejection. Aborting a connector call does **not** complete it — the transport sends the target a cancel frame and keeps waiting for the target's answer, which a target that has stopped answering never sends. That is precisely the case a liveness probe exists to report, so the deadline has to live above the call. `probeTimeoutMs` (10s) is the configurable field.

### A conversation binds at creation, or is refused before anything exists

`session.create` accepts `connectorId`. The gateway verifies the registration **first**, answers `connector-not-registered` if the id names nothing, and otherwise appends one `connector/bound` event to the session it just created. Binding after creation rather than through a creation parameter keeps the session's execution world where the rest of the seam already reads it — the log — instead of introducing a second authority the projection would have to reconcile.

The requested `cwd` for such a session is a path in the **target's** filesystem. `ensureSession` therefore takes `cwdIsLocal: false` and skips its `mkdir`: creating that absolute path on the harness host would leave a stray directory shadowing nothing the conversation ever reads.

`ConnectorRequest` gained an optional `connectorId` that outranks both the session binding and the deployment default. It is for a caller that is *about* a connector rather than inside a conversation — the probe naming the machine it checks. A capability provider never sets it, because a provider must resolve the calling session's own execution world.

### The execution world moves; nothing above it does

The shipped `connector` preset is `standard` with one group changed. An `isolate` realm over `fs`, `subprocess`, `shell`, and `settings` holds `dsh-fs-connector`, `dsh-subprocess-connector`, `dsh-bash-local`, and the provider-neutral `tool-bash` / `tool-fs` / `tool-fs-search` consumers. The realm is what makes the swap per-conversation instead of process-global: the host plane keeps its sandboxed local providers, and two sessions on this preset reach two different machines.

`settings` is in the realm for a different reason than the other three — `dsh-bash-local` registers the `shell` settings namespace, which the host's own sandboxed executor already owns and which refuses a second registration.

Three rows are deliberately absent. Delegation composes a child from the **host's** roster, so a subagent would silently run on the wrong machine. `skill-filesystem` discovers skills under local roots, which is not where this session's files are. Sandboxing is not applied to `bash-local`, because a host-machine confinement mechanism confines nothing on a target reached over a link; a connector session is shell access to the target, which enrolling the machine already granted.

### The binding is what a connector conversation has instead of a workspace

The composer refuses input until a workspace is chosen, and that gate is right for every conversation whose files are on this machine. A connector conversation has no local workspace and can never acquire one, so the gate as written left the new session permanently unusable — the one thing the quick-start action exists to avoid.

The binding is therefore carried to the client and stands in for the workspace it replaces. `session.create` echoes `connectorId`, `session.list` rows and the `host/session-added` frame report it for every attached session, and the hero chip renders a read-only `connector` variant naming the target and its directory instead of the workspace picker. There is nothing to pick: no local workspace can be substituted for a machine the conversation is bound to.

The client merges the field fill-only rather than newest-wins, unlike the preset beside it: a cold row is projected from the header index, which does not carry the binding, so a newest-wins merge would drop a known connector on the next refresh.

### Availability is checked, not assumed

`connectorPortal.list()` reports `chat: ConnectorChatAvailability`. It is `ready` only when the preset roster actually holds the configured `chatPreset` **and** that preset's composition text mounts `@deepseek-ai/dsh-fs-connector`; otherwise it carries a refusal reason (`no-preset-service`, `preset-missing`, `preset-not-connector`) and a message. A deployment that removed the preset, or edited it into a local one, says so on the page instead of quietly running the conversation on the harness host — the single failure this feature could produce that a user would not notice.

## Files

`packages/host/connector-portal` owns `probe` and `chatAvailability`; `packages/host/apiproxy` owns `connectorId` on `session.create`, the summary row, and the session-added frame; `packages/connector/connector` owns the `ConnectorRequest` field; `packages/client/ui-settings-connectors` owns both buttons; `packages/client/runtime` owns `sessions.startConnectorSession` and the summary field; `packages/client/ui-conversation` owns the read-only chip and the composer it keeps live; `apps/cli/config/agent-presets/connector` is the composition, and `packages/bundle/web-app/cordis.patch.yml` names it.

## Alternatives considered

**Report liveness from the transport's own socket state.** Rejected: a socket that is open proves the TCP connection survived, not that the agent process is still serving. A half-open connection through a NAT that forgot the mapping reads as open on this side indefinitely. The distinction matters exactly in the case the user is asking about.

**A dedicated `ping` frame in the connector wire protocol.** Rejected on the deletion test. A `resolve` + `stat` of the workdir already exercises the full request/response path plus the target's filesystem, and adds no protocol surface, no version negotiation, and nothing to keep compatible. A ping would prove strictly less.

**Poll liveness continuously and show a live indicator.** Rejected for this change. It turns one user-initiated round trip into per-row background traffic on every open Connectors page, and the honest answer it would display is still only as fresh as its last poll. An explicit action the user takes when they care is both cheaper and less misleading.

**Persist probe results.** Rejected: a stored latency is the same stale-status defect this feature exists to remove, one layer down.

**Swap the host's `ctx.fs` and `ctx.subprocess` for connector-backed ones when a session is bound.** Rejected. The host plane's providers are sandboxed and carry terminal support the connector operation set does not; replacing them process-wide would remove confinement from every session, including the ones running on the harness host. The `isolate` realm gives the same swap with the blast radius the feature actually needs.

**Bind through a creation parameter carried on the session header.** Rejected because the binding would then have two authorities — the header and the `connector/bound` event — and every reader would have to know which wins on a resumed session.

**Let the model or the user pick the connector mid-conversation.** Deferred. A session's history was produced under one execution world, and rebinding halfway leaves a transcript whose earlier file reads describe a machine the later ones cannot see. Creation time is the only moment where the answer is unambiguous.

**Offer the chat action whenever a preset named `connector` exists.** Rejected: a preset can be edited. Reading the composition for the connector-backed filesystem row is what turns "a preset with the right name" into "a preset that actually moves the execution world".

**Fall back to `standard` when the connector preset is missing.** Rejected as the worst available failure: the conversation would run on the harness host while the page said it was running on the user's machine.

## Testing

The conversation skeleton's suite covers a bound session composing without a workspace, chip and all; the client session manager's covers the create echo and the frame merge. Package suites cover the portal's four probe outcomes against a real link, including a target that holds the connection but stops answering — which is what pins the deadline, since without the race that test hangs rather than fails. The gateway suite covers binding, the skipped local `mkdir` for a target-side `cwd`, and both refusal paths. Component tests drive the two buttons through success, host refusal, and the withheld-action states. The assembled Web composition e2e composes the `connector` preset and asserts the session's `fs` and `subprocess` are the connector-backed classes while the host plane and a `standard` session beside it are untouched.

## Consequences

The Connectors page can now answer both questions, and the second one costs a deployment nothing to enable — the preset ships and the web bundle names it.

A connector conversation has no workspace. Its `cwd` is the target's workdir, and the directory picker, project roots, and everything else keyed to a local path do not apply to it. The session works; the workspace affordances around it are absent rather than wrong.

Because the binding lives only in the log, a listing that never reads the log cannot report it. A session the Host has not attached — after a restart, before it is opened — lists without a `connectorId`, so a **blank** one of those falls back to the workspace-picker posture until it is attached. A bound conversation that has already run is past the hero phase and unaffected. Closing this would mean giving the binding a second authority on the header, which the alternative below rejects for a stronger reason.

The probe measures one round trip at one moment. A machine that answers now can be gone a second later, which is why the result is presented as a timestamped measurement rather than a status the row adopts.
