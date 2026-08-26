# @deepseek-ai/dsh-instance

[English](README.md) | 中文

隔离运行时 seam。`InstanceRegistry` 注册为 `ctx.instances`，生成不透明的 `InstanceId`，驱动每个实例走完期望/观测状态机，并在 `instance/changed` 上发布每一次已提交的转换。Provider 拥有运行时如何被隔离的机制——拥有自己 harness home 的 worker 进程、容器、远程沙箱——并把它暴露为一个提供 harness `/api` 网关的 HTTP origin。

## 约定

- 实例不是 workspace（工作区）。workspace 命名的是人工作所在的目录，实例命名的是能够访问该目录的运行时。一个实例承载多个 workspace，同一个路径也可能存在于多个实例中。
- `registerProvider` 以 Provider 的 `name` 为键；重复注册抛出 `DUPLICATE_PROVIDER`，返回的 disposer（资源释放器）移除该注册。
- `create` 以 `stopped` 状态登记一个实例，并不启动任何东西。标签在存活实例之间唯一，因此控制平面可以按名字寻址；重复标签抛出 `DUPLICATE_LABEL`，未注册的 Provider 抛出 `NO_PROVIDER`。
- `start` 与 `stop` 幂等且可汇合：转换期间的第二个调用方等待第一个的结果，而不是启动第二个运行时。
- `endpoint` 恰好在 `lifecycle` 为 `running` 期间存在，`failure` 恰好在其为 `failed` 期间存在。`failed` 在下一次显式 `start` 之前是终态，而该 `start` 会先清除上一次失败再尝试。
- 运行时拒绝的 stop 落在 `failed` 而非 `stopped`：注册表无法确认运行时已消失，就不会声称如此。
- `ensureRunning` 是放置入口——它解析一个既有标签或创建一个，将其启动，并在实例未达到 `running` 时以 `START_FAILED` 拒绝。调用方永远观察不到启动到一半的实例。
- 注册表释放会停止每个存活运行时并等待每次停止，对拒绝消亡的运行时是报告而非抛出。释放期间完成的启动会把它刚拿到的运行时停掉。
- `remove` 先停止，并且永不复用 id，因此陈旧引用会大声失败，而不是访问到另一个运行时。

这条 seam 不包含任何进程、容器、HTTP、会话或路由策略。Provider 拥有隔离机制，Consumer 拥有放置与多路复用。

## 模型体验

无，因为这条 seam 只拥有实例身份与生命周期；实例内组合出的 harness 拥有那里的模型所见的每一个提示词、工具和会话事件。

#### KV Cache 影响

无；本包既不组装也不发送提供方请求。

## 已知限制与暂缓事项

- 注册表是进程内的：控制平面重启后实例不会恢复，因此存活下来的 worker 进程会成为孤儿进程，而不是被重新接管。
- 没有池、配额或调度策略。放置决策属于 Consumer，而每个对话创建一个实例的 Consumer 要为每个实例付出一次完整冷启动。
- 在 `ensureRunning` 中可寻址的键是标签而非 id；想要跨重启保持稳定寻址的 Consumer 必须以确定性方式派生自己的标签。
