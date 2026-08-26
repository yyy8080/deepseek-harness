# 隔离运行时实例

[English](instance.md) | 中文

实例注册表、其运行时 Provider，以及负责放置会话的多路复用网关共用的类型。[隔离运行时 Agent Note](../../.agents/notes/implemented/architecture/2026-08-26-isolated-runtime-instances.zh.md) 负责设计；本页记录 [`packages/instance/instance/src/types.ts`](../../packages/instance/instance/src/types.ts) 中的确切字段和变体。

## 身份与生命周期

`InstanceId` 是由注册表生成的[品牌化 id](core.zh.md#branded-ids)。它命名一个类机器的运行时，其寿命长于放置在其中的会话，这正是它与 `WorkspaceId` 的区别所在：一个实例承载多个 workspace（工作区），同一个目录路径也存在于多个实例中。

`InstanceLifecycle` 为 `'stopped' | 'starting' | 'running' | 'stopping' | 'failed'`，相对于 `'running' | 'stopped'` 的 `InstanceDesiredState` 被观测。`failed` 绝不自愈：它会保持到下一次显式启动为止，因此产生它的那次失败始终可读。

`InstanceEndpoint` 说明运行中的实例在哪里应答、以及它拥有哪棵目录树。该 origin 提供的是普通的 harness `/api` 网关，因此任何能与 harness 对话的消费方都能与实例对话。

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

## 发布出去的状态

`InstanceView` 是消费方唯一读取的投影。它是一个普通值，因此同一条记录可以原样穿过 `instance/changed`、一次注册表读取和一次协议响应。它的两个字段是「存在性精确」而不只是可选：endpoint 恰好在实例 `running` 期间出现，failure 恰好在它 `failed` 期间出现。

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

## Provider 协议

一个 Service Provider 只拥有一种隔离技术，别无其他。它启动一个运行时，在该运行时能够应答请求时兑现，并交回一个句柄，其 `stop()` 只在运行时确实消失之后才兑现——这正是注册表能够如实报告 `stopped`、而不是乐观地报告的原因。

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

## 服务行为

具体的 [`InstanceRegistry`](../../packages/instance/instance/src/index.ts) 拥有身份、状态机、可汇合且幂等的 `start` 与 `stop`、`ensureRunning` 放置入口，以及在 `instance/changed` 上的发布；它不包含任何进程、容器、HTTP、会话或路由策略。[`LocalProcessInstanceProvider`](../../packages/instance/instance-local-process/src/index.ts) 是第一个 Service Provider，为每个实例提供一个拥有自己 `DSH_HOME`、workspace 和 loopback 端口的子 harness。[`InstanceGatewayService`](../../packages/instance/instance-gateway/src/index.ts) 是 Consumer：它替代单运行时网关提供 `ctx.apiProxy`，把承载会话的域路由到拥有该会话的实例，并合并事件流。seam 约定见 [`dsh-instance`](../../packages/instance/instance/README.zh.md)，隔离机制见 [`dsh-instance-local-process`](../../packages/instance/instance-local-process/README.zh.md)，路由与放置见 [`dsh-instance-gateway`](../../packages/instance/instance-gateway/README.zh.md)。

<!-- BEGIN GENERATED cordis-surface (gen-cordis-catalog.ts) — do not edit between markers -->

<a id="cordis-surface"></a>

## Cordis API

Generated from source by `scripts/gen-cordis-catalog.ts` (verified fresh by `pnpm run verify-cordis-catalog` in doc-sync; regenerate with `pnpm run gen-cordis-catalog`) — the language sides differ only in locale-specific paired document paths. Signature blocks use a `ts cordis-catalog` fence and keep the original source JSDoc; dispatch modes are defined in the [primer](../cordis-primer.zh.md#dispatch-modes), and the framework-inherited `ctx` API lives in [cordis-api/inherited.md](../cordis-api/inherited.md).

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
