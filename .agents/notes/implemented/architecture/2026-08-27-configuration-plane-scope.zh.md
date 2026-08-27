# Agent Note: 由一个已声明的 scope 决定谁能触及配置面

Status: implemented

[English](2026-08-27-configuration-plane-scope.md) | 中文

> 取代[配置面暴露什么、谁可以覆盖什么](2026-07-30-config-plane-boundaries.zh.md)一文中的调用方边界：读取配置依然与写入配置同样属于特权操作，但「特权」不再等同于「回环」。该文的脱敏、按路径 mutate 与 revision 防串写仍然有效。

## Problem

远程 Web 部署根本无法配置任何东西。设置 → 模型打开即报 `加载提供方目录失败: settings are unavailable in this browser`，从被服务的页面上填不进任何提供方、端点或密钥。造成它的是两道彼此独立的门，其中任何一道单独存在都足以造成同样结果。

宿主 `/api` 栅栏把单一的 `PRIVILEGED_METHODS` 集合钉死在回环：它给 `isTrustedApiRequest` 传空信任表，于是 `settings.describe`、`credentials.describe` 与 `llm.discoverModels` 对一个已声明的 `trustedHosts` 权威一律回 403——部署可以为某个 host 授权运行 bash 的 `session.prompt`，却不能授权它读取自己的模型列表。

浏览器半侧随后又从页面 hostname 推导出同一条规则：只要 `ctx.connection.isLoopback` 为假，`ui-settings` 就以 memory 持久化模式构造 `SettingsDescribeMirror`，而 memory 模式的 mirror 起始状态即为 `unavailable`，永远不会发起读取。那句话就是从这里来的。同一条策略在两个进程里各存一份，互不读取，而浏览器那份根本看不见部署的 `trustedHosts` 配置——所以哪怕只放开栅栏，页面依旧是黑的。

两者之下还压着一处混同。`PRIVILEGED_METHODS` 把作用于调用方自身配置的方法，和作用于操作者桌面的方法混在了一起。`host.openPath` 与 `settings.openDocument` 打开的是**运行宿主的那台机器**上的文件管理器或编辑器；远程浏览器从中一无所得，操作者却平白多出一个窗口。这些方法永久属于回环，理由与 settings 域完全不同，可当时只有一个集合，要放开只能整体放开。

## Decision

**按作用对象拆分被钉死的方法。**`NATIVE_DESKTOP_METHODS`——`host.pickDirectory`、`host.openPath`、`settings.openDocument`、`agentPreset.openDocument`——驱动宿主自己的桌面，在任何配置下都保持回环。`CONFIGURATION_PLANE_METHODS`——`settings.*` 与 `credentials.*` 两域、`llm.discoverModels`，以及 `agentPreset.read`/`copy`/`remove` 这几个创作方法——读取并改写用户的配置与密钥存储，正是远程操作者合法需要的那一面。模型目录（`llm.providers`、`llm.models`）照旧在两者之外：它携带的是提供方 id、显示名与模型列表，远程模型选择器需要它。

**一个已声明的 scope 决定谁能触及第二组。**`ConnectionConfig.configurationPlane` 取 `'loopback'`（默认值，与此前行为完全一致）或 `'trusted-hosts'`，后者让这组方法以已配置的 `trustedHosts` 而非空表过栅栏。CLI（命令行界面）启动用 `dsh web --configuration-plane trusted-hosts` 选择它，沿 `WebStartupValues` → `WebRuntimeValues` → connection 行贯穿，因此栅栏与打印出的 LAN URL 读的是同一个结算值。

**scope 由宿主发布，浏览器不做猜测。**`client-connection` 的 node 半侧通过 `webserver/index-inject` 在每次 index 渲染时推入 `__DSH_CONFIGURATION_PLANE__`，浏览器半侧把这个全局量读入 `ctx.connection.configurationPlane`。设置表层以它为准；`ctx.connection.isLoopback` 保留给仅限桌面的动作，而这也成了它现在唯一的含义。页面全局量不携带请求上下文，因此当 scope 为 `'loopback'` 时浏览器仍会检查自己的 hostname——用页面自身的权威去收窄部署级答案，绝不会放宽它。除精确字符串 `'trusted-hosts'` 之外的任何取值，包括全局量缺失，都按回环 scope 处理；测试 fixture（测试前置数据）与 worker 预览不渲染宿主 index，拿到的就是这个关闭的默认值。

**`'trusted-hosts'` 被写明为一项信任决策，而非便利开关。**`trustedHosts` 是 DNS rebinding 栅栏，不是认证。在这个 scope 下，凡能连上该端口的调用方都可以读取配置、得知哪些环境变量存放凭据以及它们从何处解析、写入新的凭据，并让宿主向其选定的 URL 发起 GET。命令行标志的帮助文本、两个包的 README 与该类型的 JSDoc 都如实写明：选择它的部署，有义务在服务器前面为用户加一层认证。默认值没有变动，因此任何既有部署的暴露面都未改变。

## Alternatives considered

- **删掉浏览器侧的门，让 403 自己说话。** 改动最小，且直接消除了那份重复的事实——但 mirror 在 `apply` 时就读一次，早于 connect，而 HTTP 载体会把 403 变成一个无类型的传输拒绝。每个确实不受信任的远程页面都会用一句精心设计的提示换来一串原始失败字符串，而识别「被拒绝」将意味着去匹配那串字符串。否决理由是那次往返与字符串匹配，不是它的诚实。
- **通过 `host.describe` 握手发布该 scope。** 服务端事实的天然去处，但它来得太晚：`SettingsDescribeMirror` 的构造与 `ensure()` 都发生在首次握手之前，消费它就意味着让 mirror 的可用性变成异步且可重入——对 settings seam 而言，这远超本缺陷所需的改动量。
- **注入 `trustedHosts` 列表而非 scope。** 让浏览器能精确复现栅栏的判定，包括部署信任但页面当前并不在其上的权威。否决：它把部署的内部 hostname 交给每一位访客，而它要修的那处不一致本身是不可见的——问题中的那个页面，按定义正是被服务给了另一个权威。
- **让 index 注入感知请求。** 那处不一致的对症解法：宿主在渲染时就知道请求的 `Host` 头，可以按请求作答。它会波及 webserver 的 index 渲染器、frontend static 行、worker 预览的启动载荷及其文档——为一个收窄后的答案本就正确的场景，动整条渲染流水线。
- **把发布的默认值改成 `'trusted-hosts'`。** 部署将不再需要任何标志。直接否决：那会悄悄放大每一个既有 `--host 0.0.0.0` 部署的配置与密钥存储，而它们谁都没提出这个要求。
- **在不拆分的集合上做单一的 `privilegedAccess` scope。** 一个配置字段而非两个方法集合，代价是为了放开 `settings.describe` 而把 `host.openPath` 一并向远程调用方放开。两个集合的作用对象不同，因此可调用它们的人也不同。

## Consequences

传入 `--configuration-plane trusted-hosts` 的部署可以从远程浏览器配置模型提供方：目录能加载、凭据能设置、discover 能运行。作为交换，它接受端口是其密钥存储前面唯一的栅栏。什么都不传的部署行为与此前完全一致，包括 `settings are unavailable in this browser` 这句提示——而它现在名副其实：宿主拒绝把配置面服务给这个页面。

`ctx.connection.isLoopback` 不再回答「我可以配置吗」；意指配置面的消费方必须读 `configurationPlane`，而两者恰恰在本文启用的那类部署上分道扬镳。每个提供 `connection` 假件的客户端测试台都同时给出两者，分歧因此在测试中保持可见：`ui-settings-general` 断言一个被服务了配置面的远程页面仍然不提供打开文档的动作。

`packages/bundle/web-app` 新增了一条指向 `packages/client/connection` host face 的源码面引用，用于取得该 scope 类型；这是第一个引用客户端包 host tsconfig 的宿主组合包。

仍然延后、且本文未加改变的：远程部署的认证。`'trusted-hosts'` 让配置面可达，但没有让它被认证；[边界一文](2026-07-30-config-plane-boundaries.zh.md)记录的 fail-closed `describeForWire()` 依旧是尚未完成的脱敏工作。
