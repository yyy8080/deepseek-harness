# @deepseek-ai/dsh-client-connection

[English](README.md) | 中文

协议消费层：客户端插件的 apply 会挂载 `ctx.connection`（共享 API 客户端 + 当前页面的 loopback 状态 + 可观察且按 generation 生效的 `hostDescription` + 单消费方流循环启动器）；导出表层携带协议约定类型、`AbstractApiClient` 抽象，以及循环的 sink／配置类型。每次就绪握手成功后，都会在 `onConnected` 之前发布完整的 `host.describe` 值；generation 失效或显式 stop 会清空它，因此原生能力消费者不会保留已经断线的判断。浏览器载体以 HTTP POST 发送 unary／respond，并为 `events.mux` 与 `events.host` 各开一条只下行的 WebSocket；进程内载体满足同一双流抽象。导出的 `ClientTransportHooks` 命名了整体替换浏览器载体的页面全局量 `__DSH_TRANSPORT__`：served web app 不设置它、走 HTTP + WebSocket；拥有另一种物理传输的壳（worker 预览的 postMessage 隧道）则在此提供 `createApiClient` 与 `fetch`——当它同时持有 bundle 字节时再加 `loadBundle`——而不必 fork 本插件。Host half 持有唯一 `/api` route 及其 Fetch bridge；已注册的 Typert interceptor 会先认领自己的 Remote endpoint，未认领请求再回退 API Proxy。Loopback hostname 判定逻辑留在包内部：`/api` Host fence 与 WebSocket upgrade 会直接使用它，其他客户端插件则消费派生的 `ctx.connection.isLoopback` 状态，以及[配置面](#the-configuration-plane)一节所述的另一项独立状态 `ctx.connection.configurationPlane`。平台载体与 ConnectionController 循环属于包内部；apply 负责选择并驱动它们。下行边界见 [WebSocket 下行载体 Agent Note](../../../.agents/notes/implemented/architecture/2026-08-04-websocket-downlink-carrier.zh.md)。

## /api 浏览器信任栅栏

node 半侧在桥接或 upgrade 前守卫 `/api` 下的每个入口（`src/api-request-trust.ts`）。每个请求——无论是否带浏览器标记——`Host` 都必须是回环地址权威，或与某个 `trustedHosts` 条目匹配：带端口的 `host:port` 条目精确匹配，不带端口的条目匹配任意端口，两侧均经 WHATWG 归一化后比较（DNS rebinding 防御）。刻意不为无浏览器标记的 HTTP 请求开捷径：明文 HTTP 下浏览器的图片与导航读取既不带 `Origin` 也不带 Fetch-Metadata，因此无标记请求仍可能是被重绑页面发起的、响应可被读走的读取，而 Host 是重绑唯一伪造不了的请求头；WebSocket 浏览器握手会带 `Origin` 并通过同一道比较。非浏览器客户端经由回环地址、部署推导的 LAN IP 字面量或已声明的权威通过同一道栅栏。当标记存在时，如附带 `Origin`，则它必须与 Host 权威完全一致；显式的 `sec-fetch-site: cross-site` 标记一律拒绝。不是纯的、规范形 `host[:port]` 权威的 `trustedHosts` 条目——即 WHATWG 解析读回后与原文不完全一致的——会让插件加载明确报错：否则解析会悄悄授权 `harness.internal/path` 这类笔误里的 hostname，或把悬空冒号、补零端口放大成任意端口授权。HTTP 失败在任何 RPC 分发之前以纯 403 应答，upgrade 失败在启动任何事件流前拒绝握手。非回环组合必须显式信任其服务权威：Web 运行时从全接口服务器配置推导 LAN IP 字面量，cordis.yml 中的 `trustedHosts` 与 CLI（命令行界面）的 `--trusted-host` flag 则声明具名权威。`dsh web --host 0.0.0.0` 在远程访问具备认证层之前有意不受支持。这道栅栏是可达性策略，而不是认证；Web 载体不提供认证层。决策记录：[api 浏览器信任边界 Agent Note](../../../.agents/notes/implemented/architecture/2026-07-28-api-browser-trust-boundary.zh.md)。

<a id="the-configuration-plane"></a>

## 配置面

有两组方法要过的不只是 Host 栅栏。**原生桌面方法**——`host.pickDirectory`、`host.openPath`、`settings.openDocument`、`agentPreset.openDocument`——作用于运行宿主的那台机器，因此它们始终以空信任表过栅栏，无论其余配置如何都只限回环本机。**配置面方法**——`settings.describe`/`update`/`replace`/`mutate`、`credentials.describe`/`set`/`unset`、`llm.discoverModels`，以及 agent（智能体） preset 的创作方法 `agentPreset.read`/`copy`/`remove`——读取并改写用户的配置与密钥存储。读取同样属于这一面：describe 会返回已暴露的配置，探测任意引用会报出某条凭据来自何处，discover 会让宿主向调用方选定的 URL 发起 GET，而一份 preset 组装指明了一个会话所运行的插件。`agentPreset.list` 与 `agentPreset.select` 不在其中——名单只携带 id 与信任级别，而选择一个 preset 并不比 `session.create` 自带的 `agentPreset` 多给任何能力，何况默认 preset 本就带着 bash。模型目录（`llm.providers`、`llm.models`）出于同类理由也不在其中：它携带的是提供方 id、显示名与模型列表，远程模型选择器确实需要它。

`configurationPlane` 决定谁能触及第二组。默认的 `'loopback'` 让配置面与桌面方法一样以空信任表过栅栏。`'trusted-hosts'` 则让它以已配置的 `trustedHosts` 过栅栏——这正是远程浏览器得以配置模型提供方与凭据的前提，同时是一项明确的信任决策：`trustedHosts` 是 DNS rebinding 栅栏而不是认证，凡能连上该端口的调用方都会拿到这一面。选择它的部署，有义务在服务器前面为用户加一层认证。node 半侧在每次 index 渲染时把结算后的 scope 作为页面全局量 `__DSH_CONFIGURATION_PLANE__` 发布，浏览器半侧再把它读入 `ctx.connection.configurationPlane`；设置表层以宿主的答案为准，而不再从页面 hostname 自行推导一个。CLI（命令行界面）启动用 `dsh web --configuration-plane trusted-hosts` 选择该 scope。

## `/api` WebSocket 下行

`/api/events.mux` 与 `/api/events.host` 各接受一条 WebSocket upgrade，并只向浏览器发送对应的 `ServerRequest` 文本消息；客户端不会在这些 socket 上发送业务数据。任一 socket 结束都会使当前 connection generation 失败并重建两条流，连接就绪仍要求两条 socket 均已打开且 `host.describe` HTTP 调用成功。Host teardown 会终止两条 socket、中止各自的 source，并等待 source 清理完成后再返回。普通网络 GET 这些路径会返回 426，不保留 SSE（Server-Sent Events）回退；`toFetchHandler` 的 SSE 编解码只服务进程内同构载体。

## 模型体验

无。协议消费层只在浏览器与主机之间搬运已经组合好的消息；这里没有任何内容进入模型请求。

#### KV Cache 影响

无；该包既不组装也不发送提供方请求。

## 已知限制与暂缓事项

- **History 会恢复未附加的会话**：打开 history 可能创建宿主侧 agent，并增加首次打开的延迟；没有仅从持久化读取的路径。
- **`/api` 桥把每个请求体整体缓冲在内存里**：`maxRequestBodyBytes`（默认 300 MiB，按默认 200 MiB 图片总量上限经 base64 膨胀加信封余量得出）因此同时是单请求的驻留内存上界；要降低它而不缩小图片限额，需要流式请求体路径。
- **`configurationPlane: 'trusted-hosts'` 背后没有调用方身份**：栅栏授权的是一个 authority 而不是一个用户，因此该 scope 的安全性完全取决于部署在服务器前面加了什么认证。原生桌面方法在该 scope 下仍只限回环，因此远程浏览器依然打不开设置文档或目录选择器。
