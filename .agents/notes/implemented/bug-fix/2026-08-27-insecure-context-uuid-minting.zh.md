# Agent Note: Mint browser UUIDs without a secure context

Status: implemented

[English](2026-08-27-insecure-context-uuid-minting.md) | 中文

## Problem

`crypto.randomUUID` 是仅在安全上下文（secure context）中提供的 Web API。浏览器在 HTTPS 与 loopback 源下暴露它，在普通 `http://<内网或公网 IP>/` 下则不暴露：该属性根本不存在，调用即抛出 `crypto.randomUUID is not a function`。`AbstractApiClient.mintRpcId` 用它签发每一个类型化 API 的 rpcId，因此以普通 HTTP 从内网或公网地址提供的页面，在第一个 `host.describe` POST 发出之前就抛错：就绪握手永远无法完成，两条下行 WebSocket 被拆除并无限重试，UI 停留在 `Loading plugins…`。用户最先触碰的是工作区选择，错误便在那里显现。

同一个陷阱此前已经命中过通用 Connection RPC 调用方，它因此在 `dsh-client-connection` 内长出了一个私有的 `randomUuid` 助手。那个助手本身正确，但真正承载类型化 API 的包够不到它：`dsh-host-apiproxy` 位于 `dsh-client-connection` 之下，而签发浏览器本地草稿 id 的 UI 包两者都够不到。

## Decision

助手迁入 `@deepseek-ai/dsh-random-uuid`——`packages/util/` 下的零依赖包——并成为所有可能在浏览器中执行的代码路径的唯一 id 来源：`AbstractApiClient.mintRpcId`、`createWebConnectionRpc`、connection 的 fixture 载体，以及 ui-conversation 输入框的草稿附件 id。

它在平台提供 `crypto.randomUUID` 时优先使用它，否则用 `crypto.getRandomValues` 推导出相同的 v4、variant-1 布局；后者没有安全上下文限制，且由同一个 CSPRNG 支撑。Node ≥ 19 始终走第一条路径，宿主端行为不变。永不进入浏览器的宿主端代码继续使用 `node:crypto` 的 `randomUUID`。

两个方法都不提供的平台会抛错。这里刻意没有 `Math.random` 路径：静默降低 id 熵比响亮失败更糟，而支持范围内的每个引擎都至少具备其中之一。

## Alternatives considered

**改为以 HTTPS 提供该部署。** 作为修复方案被否决。证书只让症状在一个部署上消失，却让每一台普通 HTTP 的内网主机、容器和以 IP 寻址的测试主机继续损坏。浏览器协议路径的其余部分本来就无需 TLS。

**把助手留在 `dsh-client-connection`，由 apiproxy 导入。** 否决：这会反转依赖方向——`dsh-client-connection` 依赖 `dsh-host-apiproxy`，而非相反。

**把助手放进 apiproxy 的 `api/` 约定层。** 该层可从浏览器导入，且已持有 `RpcId`，fetch 载体与 connection 都能够到它。否决：那样一来，只为取一个随机数而签发浏览器本地草稿 id 的 UI 包就要依赖 API 网关包，而该助手并不属于任何协议约定。

**复用 `dsh-brand`。** 否决：该包是仅类型的、在编译期被擦除；向其中加入运行时代码会改变它的性质。

## Verification

包内测试覆盖 `randomUuid` 的两条路径：存在 `crypto.randomUUID` 时的委派、脚本化 `getRandomValues` 下的精确回退字节、饱和字节模式下的版本与 variant 打标，以及来自真实平台 CSPRNG 的取值互不相同。`packages/host/apiproxy/tests/fetch-carrier.spec.ts` 在把 `crypto` 削减到只剩 `getRandomValues` 的前提下，通过 `AbstractApiClient` 跑通一次完整的 `sessions.list`，并断言签发的 rpcId 是 v4 UUID；`packages/client/connection/tests/client-apply.client.spec.ts` 为通用 RPC 调用方保有等价断言。

修复后的构建已部署到普通 HTTP 的测试主机 `http://119.45.184.191/`，并用 headless Chromium 驱动：页面报告 `isSecureContext: false` 且 `typeof crypto.randomUUID === 'undefined'`，而工作区列表依然能加载与选中。

## Consequences

所有浏览器可达的 id 现在都出自同一处，因此未来的调用点无法在同样运行于页面中的包里悄悄重新引入安全上下文依赖。`dsh-host-apiproxy`、`dsh-client-connection` 与 `dsh-client-ui-conversation` 增加了一个自身无依赖的包依赖。在不安全源上，rpcId 不再保证来自平台自带的 UUID 实现，这无关紧要：两条路径取自同一个 CSPRNG，而该值是关联令牌，不是安全令牌。
