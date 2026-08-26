# @deepseek-ai/dsh-fs-connector

[English](README.md) | 中文

[`@deepseek-ai/dsh-fs`](../../fs/fs/README.zh.md) 提供方契约的 connector（连接器）实现。它没有配置：先挂载 [`@deepseek-ai/dsh-connector`](../connector/README.zh.md) 和至少一个 transport（传输），再用本服务替代 `dsh-fs-local`。每个操作都运行在调用会话所绑定的机器上，因此文件工具与 [`dsh-subprocess-connector`](../subprocess-connector/README.zh.md) 在那里运行的命令观察到同一个世界。

## 行为

- **会话决定机器** —— 调用会话来自发起方 agent（智能体）作用域，这是文件系统 seam 公开的唯一环境载体：其方法接受 target，而非 session。不在任何 agent 内的操作则解析部署默认值。
- **目标方言的路径计算** —— `processPath`、`fileUrl` 和 `contains` 保持同步且从不跨越链路。connector 的 OS 族选择 `posix` 或 `win32`，因此驱动 Windows 目标的 Linux harness 产生的是 `file:///C:/…` URI 和 Windows 包含规则，而不是宿主机的。`pathToFileURL` 在此不可用，因为它始终按宿主平台编码。
- **远端标识与元数据** —— `resolve`、`stat`、`lstat` 和 `listDir` 转发给目标的本地文件系统提供方，因此规范标识、符号链接处理和版本不透明性，正是 `dsh-fs-local` 在那台机器上所定义的那一套。
- **读取** —— `readText` 和 `readBytes` 在单个帧中传输整个文件；`readBytes` 在目标端由 `maxBytes` 限制，早于任何内容跨越链路。二进制拒绝和 UTF-8 校验都发生在目标端，因此模型看到的失败与本地读取产生的完全相同。
- **变更** —— `writeText` 和 `editText` 把写入意图与版本守卫带到目标端，并在那里原子发布。守卫失败以本地写入会抛出的同一批 `FsError` 码返回。
- **取消与失败** —— 中止信号会发送 `cancel` 帧，使目标停止实际工作，而不只是停止等待。`FsError` 码在本侧依据 wire 重建，因此未找到或权限失败仍可被路由，而不会退化成传输错误。

## 模型体验

间接地，通过 [`dsh-tool-fs`](../../fs/tool-fs/README.zh.md)：它渲染远端内容、目录结果、变更确认和提供方错误，而 connector 及其 transport 保持内部化。模型通过 [`dsh-connector`](../connector/README.zh.md) 向系统提示词贡献的目标描述得知自己正在哪台机器上操作。

#### KV Cache 影响

无直接失效；上述具名消费方负责其请求前缀的任何变化。

## 已知限制与暂缓事项

- **流式并非增量** —— `streamText` 在单个帧中读取整个文件并作为一个 chunk 产出。消费方保留其增量接口，但大文件会在两个进程中被整体缓冲。
- **不与宿主机同步** —— 目标的 workdir 就是那台机器上已有的内容。本地文件既不会被上传，也不会被回传反映。
- **变更协调仅限目标进程内** —— 守卫能检测目标文件系统所表示的变化，但同一 agent 的另一个客户端，或该机器上的其他任何程序，仍可能抢先替换。
- **整文件变更的开销** —— 覆盖写入的差异计算和字面量编辑会把完整文件读入目标内存并整体跨越链路，且每个操作都要付出一次往返。
