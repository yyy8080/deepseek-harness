# @deepseek-ai/dsh-subprocess-connector

[English](README.md) | 中文

[`@deepseek-ai/dsh-subprocess`](../../subprocess/subprocess/README.zh.md) 提供方契约的 connector（连接器）实现。它没有配置：先挂载 [`@deepseek-ai/dsh-connector`](../connector/README.zh.md) 和至少一个 transport（传输），再用本服务替代 `dsh-subprocess-local`。可执行文件查找与受管进程树运行在调用会话所绑定的机器上，而 stdio 处置、收集上限和取消则留在其消费方所在的 harness 进程中。

## 行为

- **会话决定机器** —— 调用会话来自发起方 agent（智能体）作用域，这是子进程 seam 公开的唯一环境载体：其方法接受 spec，而非 session。不在任何 agent 内的操作则解析部署默认值。
- **同步 seam 背后的异步启动** —— seam 同步发布句柄，而远程 spawn 做不到，因此 `pid`、stdin 写入和终止都排在发布往返之后。在目标应答之前 `pid` 读作 `-1`；被目标拒绝的 spawn 通过句柄的 `done` 报告，而不是由 `spawn` 抛出。这与 E2B 提供方所记录的异步启动安排相同。
- **输出** —— 目标始终投递两条流，本侧按 spec 的处置方式路由：`pipe` 得到原始可读流，`inherit` 得到 harness 自己的描述符，其余情况得到有界的保尾收集器。收集会报告其字节计数以及尾部是否丢失内容。
- **进程生命周期** —— `terminate` 启动目标的进程树级 SIGTERM/宽限/SIGKILL 升级；`waitForExit` 在那台机器上整棵树消失时兑现，而不是在直接子进程关闭时。资源释放会终止每个活跃句柄并等待其进程树，因此卸载该提供方不会在目标上遗留任何运行中的东西。
- **取消** —— spec 上的中止信号会终止远端进程树。已经触发过的信号会在进程树存在后立即终止它。

## 模型体验

间接地，通过 [`dsh-tool-bash`](../../shell/tool-bash/README.zh.md) 和其他子进程消费方：它们渲染远端命令输出与退出信息，而 connector 及其 transport 保持内部化。模型通过 [`dsh-connector`](../connector/README.zh.md) 向系统提示词贡献的目标描述得知自己的命令运行在哪台机器上。

#### KV Cache 影响

无直接失效；上述具名消费方负责其请求前缀的任何变化。

## 已知限制与暂缓事项

- **没有终端** —— `spawnTerminal` 以 `CONNECTOR_UNSUPPORTED` 拒绝。PTY 分配不属于 connector 操作集，因此持久 shell 能力必须挂载在同机的子进程提供方上。
- **没有 spill 文件** —— 被收集的输出在本侧保留有界的内存尾部并报告截断，但没有可以指给模型的完整流文件，因为这类文件必须位于目标端并被取回。因此被截断的流无法恢复。
- **`pid` 不会立即可用** —— 在与 `spawn` 同一 tick 中读取 `pid` 的调用方会看到 `-1`。需要真实标识符的消费方必须先 await 句柄上的第一个操作。
- **cwd 不会替调用方解析** —— spec 的 `cwd` 原样传给目标，因此它必须已经是目标世界中的绝对路径。调用方通过 `ctx.fs.processPath` 获取该路径，connector 文件系统提供方会以同一方言应答。
