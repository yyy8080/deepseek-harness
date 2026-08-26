# @deepseek-ai/dsh-instance-local-process

[English](README.md) | 中文

[instance seam](../instance/README.zh.md) 的本地进程 Service Provider。每个实例都是一个子 harness 进程，拥有自己的 `DSH_HOME`、自己的 workspace（工作区）目录和自己的 loopback `/api` 服务器，因此放置在不同实例中的会话不共享会话存储、不共享设置、也不共享 shell 状态。

## 约定

- `command` 与 `args` 必须启动一个在 loopback 上提供 `/api` 并执行本 seam 端点握手的 harness profile。`@deepseek-ai/dsh-worker` 就是那个 profile；这里的实现不假设它，因此部署方可以换成自己的。
- 每个实例拥有 `<root>/<instanceId>/`，其中包含 `home`（worker 的 `DSH_HOME`）、`workspace`（它的工作目录）和 `endpoint.json`（握手文件）。该目录树在每次启动时被删除并重建，因此陈旧端点绝不会被当成活的读取。目录按仅属主可访问创建。
- worker 通过 `ctx.subprocess` spawn，因此它从该 seam 清洗过的环境启动。凭据只能经由 `env`（显式值）或 `forwardEnv`（从控制平面自身环境中按名复制）到达它；父进程中未设置的 `forwardEnv` 名字会被跳过，而不是转发为空值。
- `DSH_HOME` 与握手变量由本 Provider 设置，`env` 无法覆盖它们。
- 就绪的判据是端点文件而非进程：`start` 在文件给出 origin 时兑现，在 worker 先行退出、注册表取消或 `readyTimeoutMs` 到期时拒绝。被拒绝的 start 会先收割它 spawn 的 worker，再重新抛出。
- `stop` 对 worker 的整棵进程树执行 subprocess seam 的 `SIGTERM → stopGraceMs → SIGKILL` 升级流程，并且只在整棵树退出之后兑现。随后 `removeStateOnStop` 删除该实例的目录树；不开启时，worker 的会话日志会保留下来供检查。

## 模型体验

无，因为本 Provider 只监督子 harness 进程；每个进程启动的 worker 组合包拥有那里的模型所见的每一个提示词、工具和会话事件。

#### KV Cache 影响

无；本包既不组装也不发送提供方请求。

## 已知限制与暂缓事项

- 隔离仅限文件系统与进程级。worker 与控制平面共享内核、网络命名空间和用户账户，因此本 Provider 是开发与单租户场景的答案，而不是安全边界。同一条 seam 背后的容器或远程沙箱 Provider 才是多租户的答案。
- worker 的输出被继承，因此它的诊断信息会落到控制平面自己的流上且不带标识。要把某一行归属到写出它的实例，需要一个本 seam 尚未做出的流所有权决策。
- 并发实例数量不受任何约束，而每个实例都是一个完整的 harness 进程。按对话创建实例的控制平面必须施加自己的上限。
- 控制平面崩溃会让运行中的 worker 成为孤儿进程：它们只能通过本进程的句柄访问，下次启动时没有任何东西会重新接管它们。
