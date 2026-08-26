# Isolated Runtime Instances

English | [中文](instance.zh.md)

Types shared by the instance registry, its runtime providers, and the multiplexing gateway that places conversations. The [isolated-runtime Agent Note](../../.agents/notes/implemented/architecture/2026-08-26-isolated-runtime-instances.md) owns the design; this page records the exact fields and variants from [`packages/instance/instance/src/types.ts`](../../packages/instance/instance/src/types.ts).

## Identity and lifecycle

`InstanceId` is a [branded id](core.md#branded-ids) minted by the registry. It names a machine-like runtime that outlives the conversations placed inside it, which is what keeps it distinct from a `WorkspaceId`: one instance hosts many workspaces, and the same directory path exists in several instances.

`InstanceLifecycle` is `'stopped' | 'starting' | 'running' | 'stopping' | 'failed'`, observed against an `InstanceDesiredState` of `'running' | 'stopped'`. `failed` never self-heals: it holds until the next explicit start, so the failure that produced it is always readable.

`InstanceEndpoint` is where a running instance answers and which tree it owns. The origin serves the ordinary harness `/api` gateway, so any consumer that can speak to a harness can speak to an instance.

```ts type-equiv
/** Where a running instance answers, and which directory tree it owns. */
interface InstanceEndpoint {
  /**
   * HTTP origin of the instance's own `/api` gateway, without a trailing
   * slash (`http://127.0.0.1:41234`). Consumers append the wire path.
   */
  origin: string
  /**
   * Absolute root of the isolated state this instance owns — its harness
   * home and workspace tree. Reported for display and cleanup; the control
   * plane never reads inside it.
   */
  root: string
}
```

## Published state

`InstanceView` is the only projection consumers read. It is a plain value, so the same record travels over `instance/changed`, a registry read, and a wire response unchanged. Two of its fields are presence-exact rather than merely optional: an endpoint appears exactly while the instance is `running`, and a failure exactly while it is `failed`.

```ts type-equiv
/** One instance as the registry publishes it; a plain value, safe to serialize. */
interface InstanceView {
  id: InstanceId
  /** Human-facing name; unique among live instances so a UI can group by it. */
  label: string
  /** Registered provider that owns this instance's runtime. */
  provider: string
  desired: InstanceDesiredState
  lifecycle: InstanceLifecycle
  /** Present exactly while `lifecycle` is `running`. */
  endpoint?: InstanceEndpoint
  /** The failure that produced `lifecycle: 'failed'`; absent otherwise. */
  failure?: string
}
```

## Provider protocol

A Service Provider owns one isolation technology and nothing else. It starts a runtime, resolves once that runtime answers requests, and hands back a handle whose `stop()` resolves only after the runtime is gone — which is what lets the registry report `stopped` truthfully instead of optimistically.

```ts type-equiv
/**
 * Service Provider protocol of the instance seam. One implementation per
 * isolation technology (a local worker process, a container, a remote
 * sandbox); the registry owns identity, state, and publication.
 */
interface InstanceProvider {
  /** Registry key; a duplicate registration fails loud. */
  name: string
  /**
   * Start one isolated runtime and resolve once it answers requests.
   * @param request - registry-minted id, label, and the give-up signal.
   * @returns the live runtime handle the registry will later stop.
   */
  start(request: InstanceStartRequest): Promise<InstanceRuntime>
}
```

```ts type-equiv
/** A live runtime a provider has started and still owns. */
interface InstanceRuntime {
  /** Where the started runtime answers. */
  endpoint: InstanceEndpoint
  /**
   * Terminate the runtime and release every resource it holds. Resolves only
   * once the runtime is gone, so the registry can report `stopped` truthfully;
   * a rejection moves the instance to `failed`.
   */
  stop(): Promise<void>
}
```

## Service behavior

The concrete [`InstanceRegistry`](../../packages/instance/instance/src/index.ts) owns identity, the state machine, joinable idempotent `start` and `stop`, the `ensureRunning` placement entry point, and publication on `instance/changed`; it contains no process, container, HTTP, session, or routing policy. [`LocalProcessInstanceProvider`](../../packages/instance/instance-local-process/src/index.ts) is the first Service Provider, giving each instance a child harness with its own `DSH_HOME`, workspace, and loopback port. [`InstanceGatewayService`](../../packages/instance/instance-gateway/src/index.ts) is the Consumer: it provides `ctx.apiProxy` in place of the single-runtime gateway, routes session-bearing domains to the instance that owns the session, and merges the event streams. See [`dsh-instance`](../../packages/instance/instance/README.md) for the seam contract, [`dsh-instance-local-process`](../../packages/instance/instance-local-process/README.md) for the isolation mechanics, and [`dsh-instance-gateway`](../../packages/instance/instance-gateway/README.md) for routing and placement.

<!-- BEGIN GENERATED cordis-surface (gen-cordis-catalog.ts) — do not edit between markers -->

<a id="cordis-surface"></a>

## Cordis API

Generated from source by `scripts/gen-cordis-catalog.ts` (verified fresh by `pnpm run verify-cordis-catalog` in doc-sync; regenerate with `pnpm run gen-cordis-catalog`) — the language sides differ only in locale-specific paired document paths. Signature blocks use a `ts cordis-catalog` fence and keep the original source JSDoc; dispatch modes are defined in the [primer](../cordis-primer.md#dispatch-modes), and the framework-inherited `ctx` API lives in [cordis-api/inherited.md](../cordis-api/inherited.md).

<a id="ctxinstancegateway--instancegatewayservice"></a>

### `ctx.instanceGateway` — `InstanceGatewayService`

The multiplexing API gateway. Provides `ctx.apiProxy` and, under its own name, the placement entry point instance CRUD consumers share.

```ts cordis-catalog
/**
 * Resolve one running instance, starting it when the placement policy asks
 * for a runtime that does not exist yet. The single entry point every "new
 * conversation" path goes through, exposed so an instance-CRUD consumer can
 * pre-warm the same runtime the next `session.create` would resolve.
 * @param conversationKey - stable key of the conversation being placed;
 * `per-conversation` derives the instance label from it so a retried create
 * lands on the same runtime.
 * @returns the resolved instance, guaranteed running.
 */
async placeConversation(conversationKey: string): Promise<InstanceView>
```

Source: [`packages/instance/instance-gateway/src/index.ts`](../../packages/instance/instance-gateway/src/index.ts)

<a id="ctxinstances--instanceregistry"></a>

### `ctx.instances` — `InstanceRegistry`

Owner of instance identity, state, and publication. Providers own how a runtime is isolated and started; this registry owns what exists, what state it is in, and who is told about it.

```ts cordis-catalog
/**
 * Register one runtime backend.
 * @param provider - the backend implementation; its `name` is the registry key.
 * @returns the disposer removing the registration.
 */
registerProvider(provider: InstanceProvider): () => void

/**
 * Register one instance in the `stopped` state. Creation never starts a
 * runtime — placement decides that, so a control plane can present the
 * catalog before paying for a cold start.
 * @param request - provider name and human-facing label.
 * @returns the new instance's published state.
 */
create(request: InstanceCreateRequest): InstanceView

/**
 * Read the whole registry.
 * @returns every registered instance's published state, in creation order.
 */
list(): InstanceView[]

/**
 * Read one instance's published state.
 * @param id - the instance identity.
 * @returns the current view, or `undefined` when no such instance exists.
 */
get(id: InstanceId): InstanceView | undefined

/**
 * Drive one instance to `running`, joining an in-flight transition rather
 * than starting a second runtime. A previous failure is cleared by the
 * attempt, so a retry reports only its own outcome.
 * @param id - the instance identity.
 * @returns the instance's published state once the transition settles.
 */
async start(id: InstanceId): Promise<InstanceView>

/**
 * Drive one instance to `stopped`, joining an in-flight transition. A stop
 * whose runtime rejects leaves the instance `failed`: the registry does not
 * know whether the runtime is gone, and saying `stopped` would be a lie.
 * @param id - the instance identity.
 * @returns the instance's published state once the transition settles.
 */
async stop(id: InstanceId): Promise<InstanceView>

/**
 * Stop one instance if needed and drop it from the registry. Removal is
 * final: the id is never reused, so a stale reference fails loud instead of
 * reaching a different runtime.
 * @param id - the instance identity.
 */
async remove(id: InstanceId): Promise<void>

/**
 * Resolve one running instance, creating and starting it when the label is
 * not yet registered. This is the placement entry point: a control plane
 * asking for "the runtime that hosts this conversation" gets a ready
 * endpoint or a loud failure, never a half-started instance.
 * @param request - provider name and human-facing label.
 * @returns the instance's published state, guaranteed `running`.
 */
async ensureRunning(request: InstanceCreateRequest): Promise<InstanceView>
```

Source: [`packages/instance/instance/src/index.ts`](../../packages/instance/instance/src/index.ts)

<a id="instance-events"></a>

### `instance/*` events

<a id="instancechanged--emit"></a>

#### `instance/changed` — emit

One instance's published state changed: creation, every lifecycle transition, and removal. Emitted only after the transition is committed to the registry, so a listener reading `ctx.instances.list()` sees the same value the payload carries. Removal is announced with the final `stopped` or `failed` view followed by nothing further for that id.

```ts cordis-catalog
/**
 * One instance's published state changed: creation, every lifecycle
 * transition, and removal. Emitted only after the transition is committed
 * to the registry, so a listener reading `ctx.instances.list()` sees the
 * same value the payload carries. Removal is announced with the final
 * `stopped` or `failed` view followed by nothing further for that id.
 * @param view - the instance's complete published state after the change.
 * @mode emit
 */
'instance/changed'(view: InstanceView): void
```

Source: [`packages/instance/instance/src/index.ts`](../../packages/instance/instance/src/index.ts)
<!-- END GENERATED cordis-surface -->
