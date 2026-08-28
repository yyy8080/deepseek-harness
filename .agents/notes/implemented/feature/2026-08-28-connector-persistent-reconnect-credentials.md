# Agent Note: Persistent, non-expiring connector reconnect credentials

Status: implemented

English | [中文](2026-08-28-connector-persistent-reconnect-credentials.zh.md)

## Problem

A user enrolled a machine through Settings → Connectors, ran the pack, and wanted the machine to stay usable: reconnect on its own after the laptop slept, the network moved, or the deployment restarted — without re-downloading a fresh pack each time. In the user's words, "连接器的密钥永远不会过期，这样可以让机器掉线了后续还能自己重新连接" — the connector key never expires, so a machine that drops can reconnect on its own afterwards.

Two things stood in the way, and only one was the credential's lifetime.

The attach path never expired a token: `admitAttach` looked the enrollment up by id and compared its secret, with no deadline. The download window's `packTtlMs` (then 30 minutes) closed only `claimDownload` — the re-fetch of the script file — and the ledger reported the machine as `expired` once that window passed. So the UI told the user the credential had expired while the machine could in fact still reconnect. The lifetime was misreported, not actually short.

The credential ledger lived only in memory. A harness restart — and, more sharply, a plugin reload, which a deployment triggers by editing its own composition — dropped every enrollment. The agent's retry loop then dialled back with a secret the restarted deployment had never heard of and was refused `403` forever, until someone issued a new pack. This was the real barrier to "reconnect on its own after the deployment restarts."

## Decision

An enrollment mints a **per-machine reconnect credential that never expires** and is **durable across restarts and reloads**, revocable only by the user.

**Non-expiring, honestly reported.** `packTtlMs` now defaults to `0`, which leaves the pack download open until the enrollment is revoked; a positive value still closes the download window as a security option, and either way it gates only the script-file re-fetch, never reconnection. `ConnectorEnrollment.expiresAt` and `ConnectorPackTicket.expiresAt` became `number | null`, with `null` meaning "the download never closes". The `expired` machine status is gone — a credential is `issued`, `downloaded`, or `attached`, and present until removed. The Connectors page shows a permanent "永久有效 · 可重连 / Never expires · auto-reconnect" marker on every enrolled machine and, for a non-expiring pack, replaces the download-deadline line with a sentence stating the machine reconnects with the same key until removed.

**Durable credential set.** `ConnectorEnrollmentStore` (`src/store.ts`) persists the durable half of every enrollment — id, secret, target family, issue time — to a JSON document at `storePath`, defaulting to `connectors/enrollments.json` under the harness home (resolved through `@deepseek-ai/dsh-home-paths`). `issue` and `revoke` are now async and persist the new set before returning, through an atomic rename behind a cross-process writer lock (`@deepseek-ai/dsh-atomic-write`), owner-only (`0600` file under a `0700` directory). The set is restored synchronously in the plugin constructor, before any route answers, so a target that dials in the instant the deployment is back up is admitted with the same secret rather than refused as unknown. A store file the build cannot read — non-JSON bytes, a wrong-typed member, or an unknown `STORE_VERSION` — throws at load rather than starting empty, because a silent empty ledger would revoke every enrolled machine at once.

**Only the credential is durable.** The live attachment is a socket and its `ctx.connectors` registration; no process carries those across a restart. The agent's existing retry loop (`runConnectorAttachment`, unchanged) re-dials and re-attaches once the deployment is back. `downloadedAt` and `attachGeneration` are within-process refinements and are not persisted; the download deadline is recomputed from `issuedAt` and the current `packTtlMs` on load.

## Store format

```json
{ "version": 1, "enrollments": [ { "id": "…", "secret": "…", "os": "linux", "issuedAt": 1724832000000 } ] }
```

`STORE_VERSION` is monotonic and refused when unknown, matching the repository's backend stance (reject old on-disk formats rather than migrate silently in the pre-release window). The secret is stored at rest, which is the security cost recorded below.

## Security model

The reconnect credential is a standing remote read/write/command capability over the machine that ran the pack. Making it non-expiring means a leaked pack or a compromised target stays usable until the enrollment is removed — there is no rotation and no per-machine time limit. This is deliberate: unattended reconnection is the feature. The controls are:

- **Per-machine secret, not a shared deployment key.** Each enrollment carries its own 24-byte secret, so `revoke` (Settings → Connectors → 移除) revokes exactly one machine: its socket is dropped and its id is refused on every later dial. Revocation, not expiry, is the guarantee the user relies on.
- **The store is as sensitive as the harness home.** It holds every machine's secret; a reader of the file can impersonate every enrolled machine's dial-in. Owner-only permissions and the harness home's own protection are the whole of that boundary.
- **The download can still be bounded.** A deployment that wants the old short-lived pack link sets `packTtlMs` to a positive value; that narrows re-fetch of the script only, and never the reconnection it authorized.

## Alternatives considered

**Keep the credential in memory and lengthen the retry-and-reissue loop.** Leaves the restart barrier exactly where it was — a target still dies on a reload and needs a fresh pack. It does not answer the user's request; durability is the only thing that lets a machine reconnect on its own across a restart.

**Rotating or expiring reconnect tokens.** More defensible in isolation, but it reintroduces the very expiry the user asked to remove: a machine offline past the window could no longer reconnect unattended, which is the whole point. Revocation gives the same "make this stop working" control without breaking unattended reconnection, so expiry buys nothing the feature can keep.

**Persist through the settings-file seam instead of a dedicated store.** The settings provider is a hot-reloaded, comment-preserving user-editable document; the credential ledger is machine-written, secret-bearing, and never hand-edited. Folding secrets into `settings.yaml` would widen that document's exposure and couple two unrelated write cadences. A small dedicated store reuses the same atomic-write and lock primitives without either cost.

**Persist the live attachment too (label, workdir, attached-at) so the ledger reads "connected" through a restart.** Rejected as a lie: the socket is gone at restart and a session binding to a "connected" row would fail at the first tool call. The honest state is that the credential survives and the agent re-dials, which is what the ledger now reports.

**Fire-and-forget the persistence write and return the ticket immediately.** Rejected: a machine enrolled in the last moment before a crash would be lost, and the store write is the commit point for "this machine can now reconnect". `issue`/`revoke` await it, matching the repository's publish-at-commit rule.

## Testing

`tests/store.spec.ts` covers the round trip and every loud-refusal path (non-JSON, wrong root, unknown version, missing array, and each malformed member field). `tests/enrollment.spec.ts` covers the non-expiring download window, restore-from-persisted admission with the same secret, and the durable-half snapshot. `tests/portal.spec.ts` drives a real agent through the assembled portal, tears the deployment down, brings a second one up against the same `storePath`, and asserts the restored enrollment admits the same agent again and that a revoked one stays gone. `ui-settings-connectors` component specs cover the permanent ticket hint and the reconnect marker.

## Consequences

A target left running reconnects on its own across a sleeping laptop, a moving network, a harness restart, and a plugin reload, with no new pack — the behavior the user asked for. The ledger no longer misreports a reconnectable machine as expired.

The cost is an unbounded, at-rest, per-machine remote-execution credential whose only off switch is revocation. The portal README's threat model and `Known Limitations` now state this plainly: a reconnect credential does not expire on its own, and the live socket (not the credential) is the part a restart drops before the agent re-dials. The `connectors.default` reload hazard the [426 attach note](../bug-fix/2026-08-28-connector-attach-lost-upgrade.md) recorded is narrowed — the enrollment now survives the reload; only its live socket drops, and the agent re-attaches.
