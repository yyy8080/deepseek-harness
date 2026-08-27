# dsh-random-uuid

[English](README.md) | 中文

一个随机标识符原语：零依赖函数，供所有需要 RFC 4122 v4 UUID 且无法假定处于安全上下文（secure context）的宿主端与浏览器端包共享。

## 为什么需要这个包

`crypto.randomUUID` 是仅在安全上下文中提供的 Web API。浏览器在 HTTPS 与 loopback 源下可以访问它，在普通 `http://<内网或公网 IP>/` 下则**不能**：该属性在那里根本不存在，调用即抛出 `crypto.randomUUID is not a function`。harness 浏览器端协议路径的其余部分都能在普通 HTTP 上工作，因此用 `crypto.randomUUID` 签发 id 的客户端会在测试或内网部署的第一次 RPC 上就失败。

`crypto.getRandomValues` 没有安全上下文限制，且由同一个 CSPRNG 支撑，所以本包在平台提供该方法时优先使用它，否则用 16 个随机字节推导出完全相同的 v4、variant-1 布局。Node ≥ 19 始终走第一条路径。

```ts
import { randomUuid } from '@deepseek-ai/dsh-random-uuid'

const id = randomUuid() // '5d1a0f0e-2b39-4c2f-9f4b-1c8a2f7d6e01'
```

它是**库，而非服务或插件**：不接触 `ctx`，不注册任何东西，不持有状态。

## 谁必须使用它

任何可能在浏览器中执行的代码路径：客户端 API 载体（`dsh-host-apiproxy` 的 `AbstractApiClient`）、通用 Connection RPC 调用方，以及签发浏览器本地草稿 id 的 UI 包。永不进入浏览器的宿主端代码可以继续使用 `node:crypto` 的 `randomUUID`。

## Known Limitations and Deferred Work

- **需要 Web Crypto 全局对象** —— 既不提供 `crypto.randomUUID` 也不提供 `crypto.getRandomValues` 的平台会抛错。这里刻意没有 `Math.random` 回退路径：静默降低 id 熵比响亮失败更糟，而支持范围内的每个引擎（浏览器、Node ≥ 19）都至少具备其中之一。
