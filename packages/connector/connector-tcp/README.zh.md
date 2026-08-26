# @deepseek-ai/dsh-connector-tcp

[English](README.md) | 中文

把部署声明的远程 connector（连接器）变成 [`ctx.connectors`](../connector/README.zh.md) 注册项，其链路通过 TCP 连接到 [`dsh-connector-agent`](../connector-host/README.zh.md)。正是这个包让执行世界得以位于另一台机器上。

## 配置

`connectors` 是一个列表；每个条目声明一个目标。

| 字段 | 含义 |
|---|---|
| `id` | 会话绑定所用的标识符。 |
| `host` | agent 的主机名或地址。优先使用 SSH 隧道之后的 loopback 地址。 |
| `port` | agent 的 TCP 端口。 |
| `os` | 目标 OS 族：`linux`、`macos` 或 `windows`。agent 必须报告相同的值。 |
| `workdir` | 目标的默认工作目录。agent 必须报告相同的值。 |
| `tokenEnv` | 存放共享密钥的环境变量。 |
| `token` | 内联共享密钥，供把配置文件本身当作密钥管理的部署使用。 |
| `connectTimeoutMs` | socket 连接加握手的截止时间。默认 10 秒。 |

`tokenEnv` 与 `token` 必须且只能提供其一，且解析出的密钥不得为空；同时提供两者、都不提供，或环境变量未设置的声明都会在加载时失败。应优先采用 `tokenEnv`，这样部署文件永远不会携带凭据。

```yaml
- @deepseek-ai/dsh-connector-tcp:
    connectors:
      - id: build-linux
        host: 127.0.0.1
        port: 8765
        os: linux
        workdir: /srv/work
        tokenEnv: DSH_BUILD_LINUX_TOKEN
```

## 行为

- **声明的事实会被校验，而非被信任** —— agent 在握手中报告其 OS 族和工作目录，与声明矛盾的 agent 所对应的链路会被拒绝。因此写错的地址不会悄无声息地把会话的文件和命令指向错误的机器。
- **握手截止时间** —— `connectTimeoutMs` 同时覆盖连接与握手，因此接受了 socket 却不作声的对端会以 `CONNECTOR_UNAVAILABLE` 失败，而不是让第一次操作挂起。
- **一条 socket，多次调用** —— 调用由客户端分配的 id 关联；被中止的调用会发送 `cancel` 帧，使 agent 停止实际工作，而不只是停止等待。
- **进程标识符由客户端分配** —— 客户端在发送 spawn 之前安装其观察者，因此某个进程的通知绝不会早于本应接收它的观察者到达。
- **socket 丢失会让一切结算** —— 每个在途调用都以 `CONNECTOR_UNAVAILABLE` 拒绝；尚未报告结果的进程被标记为失败，已报告的则被报告为进程树退出。之后的调用抛出同一失败，而不是挂起。

## 模型体验

间接地，通过 [`dsh-fs-connector`](../fs-connector/README.zh.md) 和 [`dsh-subprocess-connector`](../subprocess-connector/README.zh.md)——它们渲染跨越这条 transport 的一切——以及 [`dsh-connector`](../connector/README.zh.md) 向系统提示词贡献的目标描述。

#### KV Cache 影响

无直接失效；被点名的消费方拥有任何请求前缀变更。

## 已知限制与暂缓事项

- **纯 TCP** —— 没有 TLS、没有对端证书、没有通道绑定。除受信任的私有网络外，声明中的 `host` 应当是运维方自备隧道之后的 loopback 地址。
- **丢失的链路不会被重建** —— 注册表会丢弃失败的链路，使下一次操作打开一条新链路，但 socket 断开时正在运行的进程已经消失，没有任何机制会恢复它。
- **没有连接池或心跳** —— 一条 socket 服务绑定到该 connector 的所有会话，空闲 socket 不会被探测。悄然死亡的对端只能在下一次操作时被发现。
