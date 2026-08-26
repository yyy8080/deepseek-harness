# Agent Note: isolated runtime instances behind one gateway

Status: implemented

[English](2026-08-26-isolated-runtime-instances.md) | 中文

## Problem

一个 harness 进程就是一个运行时：一套文件系统、一个 shell、一个会话存储、一个 agent（智能体）。客户端创建的每个会话都共享它们。两个会话编辑同一个仓库时，工作树改动互相交错；其中一个执行的命令对另一个可见；其中一个里失控的进程就是全部会话里失控的进程。

产品要求恰恰相反：点击“新建对话”应当得到一个其命令在私有环境中执行的会话，并且多个这样的会话可以同时运行而互不干扰。harness 中没有任何东西命名这个“环境”——最接近的既有实体是 workspace（工作区），它命名的是用户工作所在的目录，而不是能够访问该目录的机器。

塑造答案的约束来自客户端。浏览器持有一条到 `/api` 的连接外加两条 WebSocket 下行流。将其扇出为每个运行时一条连接，会把路由、重连和流合并推入每一种客户端形态，并让运行时数量在传输层可见。

## Decision

**instance（实例）**是一等实体：一个类机器的隔离运行时，暴露一个 harness `/api` 网关并承载会话。四个包实现了它，而客户端保持不变。

`@deepseek-ai/dsh-instance` 是 Service Definition。它拥有实例身份（branded `InstanceId`）、期望/观测状态机（`stopped` / `starting` / `running` / `stopping` / `failed`，对应 `running` / `stopped` 的期望状态）以及在 `instance/changed` 上的发布。它不拥有任何隔离机制。

`@deepseek-ai/dsh-instance-local-process` 是第一个 Service Provider：每个实例一个子 harness，各自拥有自己的 `DSH_HOME`、自己的 workspace 目录和自己的 loopback 端口，全部位于 `<root>/<instanceId>/` 之下。这里的隔离是文件系统与进程级的，不是内核级的。容器或远程沙箱 Provider 可以在不改动任何 Consumer 的情况下取代它——这正是这条 seam 存在的理由。

`@deepseek-ai/dsh-worker` 是这些子进程启动的组合包：浏览器界面的宿主一半，去掉浏览器——一个 loopback `/api`，没有前端产物，没有客户端插件名册，没有原生打开转交。`dsh --profile worker` 就是 Provider 监督的那条命令。

`@deepseek-ai/dsh-instance-gateway` 是 Consumer。它替代单运行时网关提供 `ctx.apiProxy`，因此客户端既有的载体无需改动即可访问多个运行时。承载会话的域路由到拥有该会话的实例；宿主平面由控制平面自己的 `createApiProxy` 组合回答；两条事件流将控制平面自身的流与每个运行中实例的流合并。

### 就绪信号是文件，不是日志行

worker 绑定由操作系统分配的端口，因此其监督者无法预先知道 origin。在整棵 Loader 树结算之后，worker 会把一个完整的 `{"origin":"…"}` 文件重命名到 `DSH_INSTANCE_ENDPOINT_FILE` 指定的路径上，Provider 则轮询该文件。

之所以用文件而非解析输出：重命名是原子的——写了一半的 origin 永远不可观测——而且它把“进程已启动”与“进程可服务请求”区分开。之所以在 Loader 结算之后而不是服务器绑定时：监督者把握手当作“这个运行时现在可以应答”，而 `/api` 路由的拥有者是作为同级行挂载的。

### 全局会话 id

每个实例从自己的存储中生成会话 id，因此两个实例可能——并且终将——生成同一个 id。客户端看到的是 `<instanceId>~<localSessionId>`；网关在边界处改写，实例永远看不到全局 id。

改写依据 JSON 属性名——`sessionId`、`parentSessionId`、`childSessionId`、`beforeSessionId`，以及 `sessionIds` / `archivedSessionIds` 数组——而不是值的模式。属性名正是让调用 id、消息 id 和审批 id 保持原样的原因；基于值的模式只能靠猜，而每一次猜测要么漏改，要么损坏一个不属于网关的 id。

寻址到与调用路由目标不同实例的会话 id 会大声失败。放行它会让接收实例对一个确实存在（只是在隔壁运行时）的 id 回答 `session-not-found`——这是可诊断性最差的结果。

`~` 在 URL 中是非保留字符，因此全局 id 能安全通过会话日志下载的查询串。实例 id 不得包含它；本包的不变式配套插件对照注册表的权威事件流检查这一点，因为违反它会静默地把一个实例的会话路由到另一个实例。

### 放置就是会话创建

`session.create` 先解析实例，然后才在其中创建会话。因此该会话的 shell、文件系统和会话日志从它的第一个事件起就位于那个运行时中，没有后续挂接步骤，也不存在会话已存在却不在其运行位置上的时间窗口。

`per-conversation` 从调用方预分配的会话 id 派生实例标签，因此既有的创建重试契约仍会落在同一个运行时上。`shared` 把所有会话放进同一个运行时，服务于那些想要与控制平面隔离、而非兄弟会话之间隔离的部署。

超过 `maxInstances` 的放置会大声失败而不是排队。每个实例都是一个完整的 harness 进程；静默等待某个实例释放会表现为“新建对话”卡住，运维者无从把它与失败的模型调用区分开。

### 转发创建请求时丢弃了什么

`workspaceId`、`cwd` 和 `agentPreset` 命名的是控制平面自己的世界：它的 workspace 注册表、它的文件系统，以及 worker 组合包并未挂载的一份 agent preset 名册。它们被丢弃而非转发，因此会话落在实例自己的 workspace 中、由实例自己的 agent 承载。

## Alternatives considered

**每个运行时一条浏览器连接。** 客户端直接对每个实例打开 `/api`，控制平面只负责发放地址。这会完全删除网关，并连带删除 id 命名空间——每条连接本来就限定在一个存储内。它输在客户端：重连、流合并、按实例鉴权和跨实例排序都要进入每一种客户端形态，而且运行时数量会在传输层可见。既定约束是单条连接。

**用 SDK stdio 或 ACP 作为 worker 协议。** 两者都已存在，也都已在子进程中运行 harness。但两者都不承载浏览器客户端所需的域——workspace 注册表、设置与凭据平面、会话搜索、投影流——因此网关将不得不做翻译而非路由，且每新增一个 `/api` 方法就要多一层翻译。复用 `/api` 线路意味着任何已经能与 harness 对话的东西都能访问 worker，包括本次工作中用到的 `curl`。

**用网关生成的不透明 id 寻址会话。** 网关维护一张从自有 id 到 `(instance, localSessionId)` 的映射，而不是把两者编码进 id。这对客户端隐藏了实例，更整洁，也能在实例 id 变化时存活。它输在这张映射是状态：它必须持久化才能挺过控制平面重启，而丢失它的重启会让每个会话失联。组合式 id 是无状态的——任何持有注册表的进程都能路由。

**让 workspace 命名运行时。** 复用 `WorkspaceId` 本可避免引入新实体。但它混淆了两种生命周期：一个实例承载多个 workspace，同一个 workspace 路径也存在于多个实例中。注册表最终仍要长出第二种身份，只是顶着一个含义不同的名字。

**把会话通过终端桥接进运行时。** 最初的设想是会话留在控制平面、在运行时内获得一个终端。那样会话日志、文件系统工具和 agent 都留在控制平面，因此只有 shell 命令被隔离——文件编辑没有。把整个会话移入运行时，使它拥有的每个工具都因构造而隔离，而它本就携带的 shell 就是那个终端。

## Consequences

客户端未改动：本次落地在 `packages/client` 下没有任何修改。所有读取 `ctx.apiProxy` 的东西——`/api` HTTP 桥、两条 WebSocket 下行流、会话日志下载——之所以能访问多个运行时，是因为它们下面的服务变了，而不是载体变了。

在 `per-conversation` 下，冷启动现在位于“新建对话”路径上。启动一个 harness 是隔离的代价，而它正付在用户请求新会话的位置。

网关的 worker 客户端通过 WebSocket 而非基础载体的 SSE 读取两条事件流。通过 `@deepseek-ai/dsh-client-connection` 提供 `/api` 的 harness 对 `GET /api/events.mux` 回答 426 Upgrade Required，因此 `AbstractApiClient` 自带的 SSE 读取器无法访问 worker。

控制平面的 workspace 注册表看不到实例内的会话，因此客户端的 workspace 分组为空，会话呈现为未分组。按实例分组是自然的替代方案，需要客户端改动；`@deepseek-ai/dsh-instance-gateway` 的 README 记录了这一点和其余现存缺口。

可应答帧的路由是进程内的：`rpcId` → 实例的映射存放在内存中，因此控制平面重启会丢失已在途的审批与提问的路由。

## Testing

`packages/instance/instance/tests/registry.spec.ts` 钉住状态机：转换只在提交之后才广播、endpoint 恰好在运行期间发布、并发启动汇入同一次转换、失败的启动在重试时清除、其运行时拒绝停止的 stop 报告 `failed` 而非 `stopped`、被移除的 id 永不复用，以及释放会触及每个存活运行时——包括在拆除开始之后才完成启动的那个。“endpoint 恰好在运行期间发布”这条用例发现了一个真实缺陷：正在停止的实例仍持有运行时句柄以便 stop 能触及它，而它的视图当时正在发布那个已失效的 endpoint。

`packages/instance/instance-gateway/tests/` 钉住双向 id 改写，以及扇入缓冲区的到达顺序、关闭、中止和清理行为。

`examples/instance-runtimes/` 是组装后的路径。目前还没有快照覆盖它：快照测试框架回放的是单个运行时的 transcript（文本记录），而多运行时 transcript 需要框架支持按实例回放。在此之前该示例由人工验证——两个会话落在不同运行时上并具有不同的 `cwd`，合并后的 mux 流承载来自每个运行时（包括在流打开之后才启动的那个）的全局化帧，以及无法路由的会话 id 被拒绝。
