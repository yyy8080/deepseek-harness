# @deepseek-ai/dsh-connector

[English](README.md) | 中文

connector 能力 seam（`ctx.connectors`）的 Service Definition。一个 connector（连接器）指向一台机器和一个操作系统族；注册表保存已配置的 connector，解析某个会话运行在哪一个上，并交出其能力提供方共用的链路。transport（传输）包负责注册 connector，[`dsh-fs-connector`](../fs-connector/README.zh.md) 和 [`dsh-subprocess-connector`](../subprocess-connector/README.zh.md) 消费其结果。

## 配置

| 字段 | 含义 |
|---|---|
| `default` | 当会话日志中没有 `connector/bound` 事件时，该会话所运行的 connector。省略它即要求每次会话都显式绑定。 |

解析失败会大声报错：无注册项应答的 `default`，或绑定到未注册 id 的会话，都会在操作处抛出 `CONNECTOR_UNKNOWN`，而不是在加载时静默处理——因为 transport 插件可能在同一应用中更晚注册。

## 行为

- **注册表** —— `register(descriptor, open)` 通过 `ctx.effect` 贡献一个 connector 并返回其 disposer；重复 id 会抛错，因为把两台机器命名为同一名称的部署无法解析。`list`、`get`、`describe` 和 `tryDescribe` 读取这些注册项。
- **会话绑定** —— `bindSessionConnector(session, id)` 追加一个 `connector/bound` 事件；`effectiveConnectorId(events)` 把日志折叠回最后一次绑定。会话日志即存储，因此绑定通过重放在重启后依然有效，且两次会话永远不会共享目标。该事件仅记录于日志，与 `sandbox/mode` 一样：持久且可重放，永不进入模型 transcript（对话记录）。
- **链路生命周期** —— `link(request)` 在首次使用时打开该 connector 的链路，并为其后所有调用方 memo（记忆化）该链路；打开失败不会被 memo，因此下一次操作会重试。资源释放会关闭注册表打开的链路，`connector/link-opened` 与 `connector/link-closed` 发布这些状态变化。
- **目标方言** —— `connectorPathModule(os)` 为 Windows 目标返回 Node 的 `win32` 路径模块，其余返回 `posix`。connector 支撑的提供方执行的所有同步路径计算都运行在目标的方言下，而非 harness 宿主机的方言。
- **wire 协议** —— [`./protocol`](src/protocol.ts) 定义以换行分隔的 JSON 帧：携带协议修订号的 `hello`/`ready` 握手、相互关联的 `call`/`result`/`error` 帧、`cancel`，以及由服务端发起、描述某个进程输出、关闭、失败与进程树退出的 `event` 帧。帧在到达时被校验，并限制在 64 MiB 以内，因为在握手完成前对端是远程且未经认证的。agent 与每个客户端 transport 都通过这一个模块解码。
- **失败** —— `ConnectorError` 携带 `CONNECTOR_UNKNOWN`（无此 connector）、`CONNECTOR_UNAVAILABLE`（链路无法打开或已丢失）、`CONNECTOR_PROTOCOL`（对端违反 wire 契约）和 `CONNECTOR_UNSUPPORTED`（目标世界无法执行该操作）。

## 模型体验

### 目标机器系统提示词上下文

#### 模型看到的内容

一个 order 为 105 的 `connector:target` 上下文块，说明调用会话解析出的 connector、它的操作系统族以及工作目录——使模型写出该目标的路径语法和命令，而不是 harness 宿主机的。没有会话的裸组装、没有注册项应答的绑定，以及未配置的 default，都不贡献任何内容；失败的操作会用自己的类型化错误报告缺失的 connector。

##### 渲染出的块

```markdown
File and command operations in this session run on connector "lab-win", a Windows machine, not on the machine hosting this conversation. Use Windows path syntax and commands, and treat "C:\\work" as the working directory.
```

#### Token 影响

一句话、数十个 token，对解析出 connector 的会话每次请求出现一次。它不随已注册 connector 的数量增长：只描述被解析出的那一个。

#### KV Cache 影响

该块位于稳定的系统提示词前缀中。把会话绑定到另一个 connector 会重写它，使该会话的前缀失效一次——与任何其他系统提示词上下文变更的代价相同。

## 已知限制与暂缓事项

- **会话中途改绑不会迁移任何东西** —— 第二个 `connector/bound` 事件会把后续操作指向另一台机器，但已写入的文件和已运行的进程仍留在原处。没有任何机制会发现 transcript 现在描述了两个世界。
- **每个 connector 一条链路，由所有会话共享** —— 绑定到同一 connector 的会话共享一条 transport 和一个目标工作目录。共享目标上的会话级隔离属于 sandbox seam 的职责，不属于此 seam。
- **没有存活探测** —— 链路在首次使用时打开并保持到资源释放。目标消失只能通过下一次操作失败被发现，无法提前得知。
