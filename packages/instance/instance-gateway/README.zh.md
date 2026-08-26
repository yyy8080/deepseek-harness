# @deepseek-ai/dsh-instance-gateway

[English](README.md) | 中文

架在 [instance seam](../instance/README.zh.md) 之上的多路复用 API 网关。它提供 `ctx.apiProxy`，因此 `@deepseek-ai/dsh-client-connection` 已挂载的每个载体——`/api` HTTP 桥、`events.mux` 与 `events.host` WebSocket 下行流，以及会话日志下载——都能继续工作，而它们背后的会话则运行在彼此隔离的独立运行时中。

挂载它是为了**替代** `@deepseek-ai/dsh-host-apiproxy` 自带的 `ApiProxyService`；两者提供同一个服务名，而一个服务有两个提供方会导致加载失败。

## 路由去向

| 域 | 由谁回答 |
| --- | --- |
| `sessions`、`subagents`、`skills`、`goals` | 拥有请求体中所指会话的那个实例 |
| `session.list`、`session.search` | 全部运行中实例，结果拼接 |
| `session.create` | 新解析出的实例（见[放置](#placement)） |
| `events.mux`、`events.host` | 控制平面自己的流，与每个运行中实例的一条流合并 |
| `respond` | 其可应答帧携带该 `rpcId` 的那个实例 |
| `downloads.sessionLog` | 全局会话 id 所指的那个实例 |
| `host`、`workspace`、`agentPresets`、`settings`、`credentials`、`llm` | 控制平面自己的组合 |

## 全局会话 id

每个实例从自己的存储中生成会话 id，因此两个实例可能生成同一个 id。为此网关向客户端展示 `<instanceId>~<localSessionId>` 并在边界处改写：实例永远看不到全局 id，控制平面也永远不按本地 id 路由。改写依据 JSON 属性名（`sessionId`、`parentSessionId`、`childSessionId`、`beforeSessionId`，以及 `sessionIds` / `archivedSessionIds` 数组），这正是让调用 id、消息 id 和审批 id 保持原样的原因。

寻址到与调用路由目标不同实例的会话 id 会大声失败，而不是被放行：接收实例会对一个确实存在（只是在隔壁运行时）的 id 回答 `session-not-found`。

<a id="placement"></a>

## 放置

`session.create` 先解析实例再创建会话，因此该会话的 shell、文件系统和会话日志从它的第一个事件起就位于那个运行时中。

- `per-conversation`（默认）从调用方预分配的会话 id 派生实例标签，使每个会话拥有自己的运行时。以相同预分配 id 重试的创建会落在同一个运行时上。
- `shared` 把所有会话都放进 `sharedLabel` 所指的那一个实例。

`workspaceId`、`cwd` 和 `agentPreset` 会从转发出去的创建请求中丢弃：它们各自命名的都是控制平面自己世界中的东西（它的 workspace（工作区）注册表、它的文件系统、worker 组合包并未挂载的一份 preset 名册），因此会话落在实例自己的 workspace 中、由实例自己的 agent（智能体）承载。

## 配置

```yaml
- '@deepseek-ai/dsh-instance-gateway':
    provider: local-process
    placement: per-conversation
    sharedLabel: shared
    maxInstances: 8
    requestTimeoutMs: 60000
```

| 键 | 含义 |
| --- | --- |
| `provider` | 必填；新会话被放置到的 instance Provider |
| `placement` | `per-conversation` 或 `shared` |
| `sharedLabel` | `shared` 放置所解析的实例标签 |
| `maxInstances` | 已登记实例数量的上限；超出后的放置大声失败而不是排队 |
| `requestTimeoutMs` | 对实例的单次一元调用的期限；事件流不受此限制 |

未注册的 `provider` 会让首次放置失败，而不是让加载失败：Provider 在各自的 fiber 上注册，本服务构造时它们可能尚未应用。

## 模型体验

无，因为网关只在运行时之间路由已组装好的 API 消息；会话落到哪个实例，就由那个实例拥有该会话的模型所见的每一个提示词、工具 schema 和会话事件。

#### KV Cache 影响

无；本包既不组装也不发送提供方请求。

## 已知限制与暂缓事项

- **控制平面的 workspace 注册表看不到实例内的会话。** `workspace.list` 由控制平面回答，而会话存在于实例中，因此客户端的 workspace 分组为空，会话呈现为未分组。按实例分组是自然的替代方案，需要客户端改动。
- **`session.list` 的分页是按实例的。** 扇入会拼接每个实例的第一页，并从最后一个有贡献的实例取用非数组类响应字段；跨实例的游标需要一个复合游标。
- **实例 CRUD 未暴露在协议层。** 放置隐含在 `session.create` 中；`ctx.instanceGateway.placeConversation` 是进程内的入口。经由 `ctx.connection.rpc.handle` 的 `/instances` 通道是计划中的接口。
- **可应答帧的路由是进程内的。** `rpcId` → 实例的映射存放在内存中，因此控制平面重启会丢失已在途的审批与提问的路由；客户端会重开它的流、实例会重放它们，但重放的帧只有在合并重新挂接之后才带上新的路由。
