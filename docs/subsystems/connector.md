# Connectors

English | [中文](connector.zh.md)

The connector seam — a [capability seam](../../.agents/notes/implemented/architecture/2026-08-26-connector-execution-world.md) that names the machines a deployment can execute on and decides which one a conversation runs against. It is split across packages: Service Definition ([dsh-connector](../../packages/connector/connector), `ctx.connectors`), Service Providers registering targets ([dsh-connector-host](../../packages/connector/connector-host) for this machine, [dsh-connector-tcp](../../packages/connector/connector-tcp) for a remote agent), and Consumers implementing the execution world over the selected target ([dsh-fs-connector](../../packages/connector/fs-connector), [dsh-subprocess-connector](../../packages/connector/subprocess-connector)).

A connector carries no execution semantics of its own. `ctx.fs` and `ctx.subprocess` still define the execution world, exactly as [the portable execution-world decision](../../.agents/notes/implemented/architecture/2026-07-28-portable-execution-world-consumers.md) states; this seam answers the question that decision left open — *which* world, per session.

Source: [`packages/connector/connector/src/types.ts`](../../packages/connector/connector/src/types.ts)

## The target

A connector is identified by an opaque [branded](core.md#branded-ids) `ConnectorId` a deployment chooses, and it publishes two static facts before its first operation runs.

```ts type-equiv
/** Static facts a connector publishes before its first operation runs. */
interface ConnectorDescriptor {
  /** Deployment-chosen identifier sessions bind to. */
  id: ConnectorId
  /** Target-OS family, which fixes the path dialect of every returned path. */
  os: ConnectorOs
  /**
   * Absolute directory in the target world that relative paths and default
   * spawns resolve against.
   */
  workdir: string
}
```

`ConnectorOs` is load-bearing rather than informational. The filesystem seam's `processPath`, `fileUrl`, and `contains` are synchronous, so they cannot ask the target what a path means; the OS family selects `posix` or `win32` for all three. That is why a declaration states it and why a transport refuses a link whose agent reports something else — a Linux harness driving a Windows target must produce `file:///C:/…` and Windows containment rules, and a mistyped address must not silently answer as the wrong machine.

```ts type-equiv
/**
 * Operating-system family of a connector's execution world. It selects the
 * path dialect (`win32` for `windows`, `posix` otherwise) every synchronous
 * path computation in a connector-backed filesystem provider uses, so it is a
 * required part of a connector declaration rather than something discovered
 * per call.
 */
type ConnectorOs = 'linux' | 'macos' | 'windows'
```

## Which connector a call runs on

Binding is one session event. `bindSessionConnector(session, id)` appends `connector/bound`, and `effectiveConnectorId(events)` folds the log back to the last one — the same log-as-store arrangement `sandbox/mode` uses for execution policy, so a conversation's target survives restart by replay. The event never enters the model transcript.

`ConnectorRequest` is what a provider passes when it resolves. Neither capability seam takes a session in its method signatures, so both providers read the initiating-agent scope, which is the only ambient carrier either exposes. A call outside any agent resolves the deployment default.

```ts type-equiv
/** Inputs that select the connector for one capability call. */
interface ConnectorRequest {
  /** Calling session; its last `connector/bound` event outranks the deployment default. */
  session?: Session
}
```

## The link

`ConnectorLink` is one live connection to a target's execution world, opened by the registry on first use and shared by every consumer bound to that connector. Its two operation sets are wire-neutral: the same interfaces back the in-process host and the TCP client, which is what lets a same-machine deployment and a remote one exercise identical code.

The operation sets mirror `ctx.fs` and `ctx.subprocess` minus everything a consumer can compute locally. `processPath`, `fileUrl`, and `contains` never cross the link, because a path plus `ConnectorOs` is enough. `readBytesBase64` caps the transfer on the target, before content crosses. A spawn always delivers both output streams, because collection limits, spill, and pass-through are consumer decisions that need the bytes either way.

Process identifiers are assigned by the **client** in the spawn call rather than returned by the target. That ordering is the point: the client installs its observer before the spawn is sent, so a failure the target reports before the round-trip returns cannot arrive ahead of the observer that would have received it.

## Failures

`ConnectorError` carries four codes. `CONNECTOR_UNKNOWN` names a connector id no registration answers — a session bound to a target this deployment does not offer, or a missing default. `CONNECTOR_UNAVAILABLE` covers a link that cannot be opened or was lost mid-operation. `CONNECTOR_PROTOCOL` reports a peer that violated the wire contract. `CONNECTOR_UNSUPPORTED` reports an operation the target world cannot perform at all, which is how `spawnTerminal` refuses: PTY allocation is not part of the operation set, so a persistent-shell capability mounted against a connector fails loudly instead of running the shell on the wrong machine.

Filesystem failures are not collapsed into transport failures. The target's `FsError` code crosses the wire and is rebuilt on this side, so a not-found or permission denial stays routable by the same code a local read would raise.

<!-- BEGIN GENERATED cordis-surface (gen-cordis-catalog.ts) — do not edit between markers -->

<a id="cordis-surface"></a>

## Cordis API

Generated from source by `scripts/gen-cordis-catalog.ts` (verified fresh by `pnpm run verify-cordis-catalog` in doc-sync; regenerate with `pnpm run gen-cordis-catalog`) — the language sides differ only in locale-specific paired document paths. Signature blocks use a `ts cordis-catalog` fence and keep the original source JSDoc; dispatch modes are defined in the [primer](../cordis-primer.md#dispatch-modes), and the framework-inherited `ctx` API lives in [cordis-api/inherited.md](../cordis-api/inherited.md).

<a id="ctxconnectors--connectorregistry"></a>

### `ctx.connectors` — `ConnectorRegistry`

The connector registry (`ctx.connectors`). Transport plugins register the connectors a deployment configured; capability providers resolve the calling session's connector and operate through its shared link.

```ts cordis-catalog
/**
 * Register one connector and the opener its shared link uses. Registering a
 * duplicate id throws: a deployment naming two machines the same way cannot
 * be resolved, and silently keeping one would bind sessions to the wrong
 * target.
 * @param descriptor - the connector's identity, OS family, and workdir.
 * @param open - opens the shared link; called at most once until it closes.
 * @returns the disposer, which closes an opened link.
 */
register(descriptor: ConnectorDescriptor, open: ConnectorOpener): () => void

/**
 * Every registered connector, in registration order.
 * @returns the registered descriptors.
 */
list(): ConnectorDescriptor[]

/**
 * Look up one connector without resolving a session binding.
 * @param id - the connector id to look up.
 * @returns the descriptor, or undefined when no registration answers that id.
 */
get(id: ConnectorId): ConnectorDescriptor | undefined

/**
 * Resolve which connector one capability call runs on. The session's last
 * `connector/bound` event outranks the deployment default.
 * @param request - the calling session, when there is one.
 * @returns the resolved connector id.
 */
resolveId(request: ConnectorRequest = {}): ConnectorId

/**
 * Resolve the connector for one capability call and require its registration.
 * @param request - the calling session, when there is one.
 * @returns the resolved descriptor.
 */
describe(request: ConnectorRequest = {}): ConnectorDescriptor

/**
 * Resolve the connector for one call without raising when nothing answers.
 * @param request - the calling session, when there is one.
 * @returns the resolved descriptor, or undefined when none can be resolved.
 */
tryDescribe(request: ConnectorRequest = {}): ConnectorDescriptor | undefined

/**
 * Obtain the shared live link for one capability call, opening it on first
 * use. Concurrent callers await the same opening; a failed opening is not
 * memoized, so the next call retries.
 * @param request - the calling session, when there is one.
 * @returns the connector's live link.
 */
async link(request: ConnectorRequest = {}): Promise<ConnectorLink>
```

Source: [`packages/connector/connector/src/index.ts`](../../packages/connector/connector/src/index.ts)

<a id="connector-events"></a>

### `connector/*` events

<a id="connectorlink-closed--emit"></a>

#### `connector/link-closed` — emit

A connector's shared link was released, either because its registration was disposed or because the registry itself is unloading.

```ts cordis-catalog
/**
 * A connector's shared link was released, either because its registration
 * was disposed or because the registry itself is unloading.
 * @param descriptor - the connector whose link is no longer live.
 * @mode emit
 */
'connector/link-closed'(descriptor: ConnectorDescriptor): void
```

Source: [`packages/connector/connector/src/index.ts`](../../packages/connector/connector/src/index.ts)

<a id="connectorlink-opened--emit"></a>

#### `connector/link-opened` — emit

A connector's shared link finished opening and is now serving operations. Emitted once per connector until the link is closed.

```ts cordis-catalog
/**
 * A connector's shared link finished opening and is now serving
 * operations. Emitted once per connector until the link is closed.
 * @param descriptor - the connector whose link became live.
 * @mode emit
 */
'connector/link-opened'(descriptor: ConnectorDescriptor): void
```

Source: [`packages/connector/connector/src/index.ts`](../../packages/connector/connector/src/index.ts)
<!-- END GENERATED cordis-surface -->
