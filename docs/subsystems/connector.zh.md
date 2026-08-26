# Connectors

[English](connector.md) | 中文

connector（连接器）seam —— 一个[能力 seam](../../.agents/notes/implemented/architecture/2026-08-26-connector-execution-world.zh.md)，它为部署可执行的机器命名，并决定某次会话运行在哪一台上。它拆分在多个包中：Service Definition（[dsh-connector](../../packages/connector/connector)，`ctx.connectors`）、注册目标的 Service Provider（[dsh-connector-host](../../packages/connector/connector-host) 用于本机，[dsh-connector-tcp](../../packages/connector/connector-tcp) 用于远程 agent），以及在所选目标之上实现执行世界的 Consumer（[dsh-fs-connector](../../packages/connector/fs-connector)、[dsh-subprocess-connector](../../packages/connector/subprocess-connector)）。

connector 自身不承载任何执行语义。正如[可移植执行世界决策](../../.agents/notes/implemented/architecture/2026-07-28-portable-execution-world-consumers.zh.md)所述，`ctx.fs` 与 `ctx.subprocess` 仍然定义执行世界；该 seam 回答的是那个决策留下的问题——逐会话地，是*哪一个*世界。

来源：[`packages/connector/connector/src/types.ts`](../../packages/connector/connector/src/types.ts)

## 目标

connector 由部署选定的、不透明的 [branded](core.zh.md#branded-ids) `ConnectorId` 标识，并在其第一个操作运行前发布两项静态事实。

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

`ConnectorOs` 是承重的，而非仅供参考。文件系统 seam 的 `processPath`、`fileUrl` 和 `contains` 是同步的，因此无法询问目标某个路径意味着什么；OS 族为三者选择 `posix` 或 `win32`。这就是声明必须写明它、以及 transport 会拒绝 agent 报告值不符的链路的原因——驱动 Windows 目标的 Linux harness 必须产生 `file:///C:/…` 和 Windows 包含规则，而写错的地址绝不能以错误机器的身份悄悄应答。

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

## 某次调用运行在哪个 connector 上

绑定是一个会话事件。`bindSessionConnector(session, id)` 追加 `connector/bound`，`effectiveConnectorId(events)` 把日志折叠回最后一个——这与 `sandbox/mode` 用于执行策略的“日志即存储”安排相同，因此一次会话的目标通过重放在重启后依然有效。该事件永不进入模型 transcript（对话记录）。

`ConnectorRequest` 是提供方在解析时传入的内容。两个能力 seam 的方法签名都不接受 session，因此两个提供方都读取发起方 agent（智能体）作用域，这是二者各自公开的唯一环境载体。不在任何 agent 内的调用解析部署默认值。

```ts type-equiv
/** Inputs that select the connector for one capability call. */
interface ConnectorRequest {
  /** Calling session; its last `connector/bound` event outranks the deployment default. */
  session?: Session
}
```

## 链路

`ConnectorLink` 是通往某个目标执行世界的一条活动连接，由注册表在首次使用时打开，并由绑定到该 connector 的所有消费方共享。它的两个操作集与 wire 无关：同一批接口既支撑进程内 host，也支撑 TCP 客户端——正因如此，同机部署与远程部署才能走完全相同的代码。

这些操作集镜像 `ctx.fs` 与 `ctx.subprocess`，但去掉了消费方可在本地计算的一切。`processPath`、`fileUrl` 和 `contains` 从不跨越链路，因为路径加 `ConnectorOs` 已经足够。`readBytesBase64` 在目标端、在内容跨越之前就限制传输量。spawn 始终投递两条输出流，因为收集上限、spill 和透传都是消费方的决定，而它们无论如何都需要这些字节。

进程标识符由**客户端**在 spawn 调用中分配，而不是由目标返回。这一顺序正是要点：客户端在发送 spawn 之前安装其观察者，因此目标在往返返回前报告的失败，不可能早于本应接收它的观察者到达。

## 失败

`ConnectorError` 携带四种码。`CONNECTOR_UNKNOWN` 指向没有注册项应答的 connector id——会话绑定到了本部署未提供的目标，或缺少默认值。`CONNECTOR_UNAVAILABLE` 覆盖无法打开或在操作中途丢失的链路。`CONNECTOR_PROTOCOL` 报告违反 wire 契约的对端。`CONNECTOR_UNSUPPORTED` 报告目标世界根本无法执行的操作，`spawnTerminal` 正是以此拒绝：PTY 分配不属于该操作集，因此挂到 connector 上的持久 shell 能力会大声失败，而不是把 shell 运行在错误的机器上。

文件系统失败不会被坍缩成传输失败。目标的 `FsError` 码会跨越 wire 并在本侧重建，因此未找到或权限拒绝仍可按本地读取会抛出的同一个码进行路由。

<!-- BEGIN GENERATED cordis-surface (gen-cordis-catalog.ts) — do not edit between markers -->

<a id="cordis-surface"></a>

## Cordis API

Generated from source by `scripts/gen-cordis-catalog.ts` (verified fresh by `pnpm run verify-cordis-catalog` in doc-sync; regenerate with `pnpm run gen-cordis-catalog`) — the language sides differ only in locale-specific paired document paths. Signature blocks use a `ts cordis-catalog` fence and keep the original source JSDoc; dispatch modes are defined in the [primer](../cordis-primer.zh.md#dispatch-modes), and the framework-inherited `ctx` API lives in [cordis-api/inherited.md](../cordis-api/inherited.md).

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
 * @returns the disposer, which closes an opened link and settles once closed.
 */
register(descriptor: ConnectorDescriptor, open: ConnectorOpener): () => Promise<void>

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
