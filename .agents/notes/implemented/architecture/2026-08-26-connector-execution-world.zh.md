# Agent Note: connector —— 执行世界位于后端选定的机器上

Status: implemented

[English](2026-08-26-connector-execution-world.md) | 中文

## Problem

一个 harness 部署可用的执行世界恰好只有一个：进程自身所在的机器。已发布的每个文件系统与子进程提供方，要么在宿主机上操作（`dsh-fs-local`、`dsh-subprocess-local`），要么创建一个由自己全程拥有的全新一次性世界（`dsh-fs-e2b`、`dsh-subprocess-e2b`）。这迫使后端与终端位于同一台宿主机上：要让 agent（智能体）访问开发者的构建机、实验室的 Windows 机器或某台既有服务器，就必须把整个 harness 连同其模型凭据、会话存储、审批流程和插件图一起部署到那里。

[可移植执行世界决策](2026-07-28-portable-execution-world-consumers.zh.md)已经确立：`ctx.fs` 与 `ctx.subprocess` 共同定义一个执行世界，且远程世界是一对 Service Provider，而不是对每个消费方的 fork。它没有确立的是：一个部署如何为多个这样的世界命名、一次会话如何选中其一，以及用什么协议触达运维方已有的机器（而非沙箱厂商的 API）。

E2B 对这些都没有回答：它创建自己的 Linux 沙箱，没有“运维方提供的目标”这一概念，没有 Windows 方案，也没有会话级选择——沙箱是部署级的单例。

## Decision

**connector（连接器）** 是一个一等能力 seam（`ctx.connectors`），指向一台机器和一个操作系统族。注册表保存部署所配置的 connector，解析某个会话运行在哪一个上，并为每个 connector 交出一条共享链路。`dsh-fs-connector` 与 `dsh-subprocess-connector` 在该链路之上实现两个执行世界 seam。它们之上的消费方无需改动，因为其所有操作本就以 `ctx.fs` 和 `ctx.subprocess` 表述。

四个选择支撑了该设计。

**绑定是一个会话事件。** `bindSessionConnector` 追加一个 `connector/bound` 事件，`effectiveConnectorId` 把日志折叠回最后一个——与 `sandbox/mode` 处理执行策略的方式完全一致。会话日志即存储，因此一次会话的目标机器通过重放在重启后依然有效，且两次会话永远不会看到彼此的目标。该事件仅记录于日志：它持久且可重放，但永不进入模型 transcript（对话记录），因此不需要 surface 操作。提供方在每个操作边界解析该折叠，这正是让文件系统与子进程 seam 就同一个世界达成一致的原因——尽管两者之间并不传递 session，它们都读取发起方 agent 作用域，这是两个 seam 各自公开的唯一环境载体。

**目标端复用已发布的本地提供方。** `createConnectorHost` 构建一个私有 Cordis 应用，其中只有 `dsh-fs-local` 和 `dsh-subprocess-local`，并把它投影到 connector 操作集上。因此文件系统标识、原子发布、行尾处理、进程树、PATH 与 PATHEXT 查找以及 Windows 进程树终止都只保留一份实现，无论 agent 运行在 harness 旁边还是另一台机器上。Windows 支持不是单独的移植；它就是 `dsh-subprocess-local` 与 `dsh-fs-local` 运行在 Windows 上时本来的行为。

**wire 采用 TCP 之上以换行分隔的 JSON。** 它在两端都不需要依赖，在 Linux 和 Windows 上原样运行，并且无需理解负载的代理即可通过 `ssh -L` 隧道传输。帧集合包括：携带协议修订号的 `hello`/`ready` 握手、相互关联的 `call`/`result`/`error` 帧、`cancel`，以及由服务端发起、描述某个进程输出、关闭、失败与进程树退出的 `event` 帧。帧在到达时被校验并受长度限制，因为在握手完成前对端是远程且未经认证的。

**路径方言属于 connector，而非宿主机。** `processPath`、`fileUrl` 和 `contains` 必须保持同步，因此无法询问目标。描述符的 OS 族为三者选择 `posix` 或 `win32`——这正是 OS 成为声明必填项、以及 agent 必须在握手中确认它的原因：驱动 Windows 目标的 Linux harness 必须产生 `file:///C:/…` 和 Windows 包含规则，而与 agent 相矛盾的声明会被拒绝，而不是被默默信任。

还有两个较小的后果值得记录。进程标识符由**客户端**在 spawn 调用中分配，因此客户端在目标能够投递第一条通知之前就已安装观察者——另一种做法会丢失在往返返回前到达的 spawn 失败。以及，关闭连接会中止该客户端在途的调用并终止它启动的进程树，因此客户端无法通过断开连接把工作遗留在目标上继续运行。

## Consequences

agent 循环、模型调用、工具编排、会话日志与持久化、审批、skill（技能）和插件图都留在 harness 进程中。connector 只迁移文件与进程操作，别无其他。它不是 sandbox（沙箱）：共享目标上的约束仍属 sandbox seam 的职责，connector 与之组合而非取代它。

挂载 connector 支撑的提供方的部署要接受三条限制。connector 上没有持久终端：`spawnTerminal` 报告 `CONNECTOR_UNSUPPORTED`，因此持久 shell 能力必须留在本地执行世界。收集到的输出是有界的内存尾部，没有 spill 文件，因此被截断的流会报告截断，但不提供取回其余部分的路径。以及，远程 spawn 无法同步报告 pid，因此 `handle.pid` 在往返返回前为 `-1`，这与 E2B 的现状相同。

TCP agent 是一个由单个共享 token 守卫、不受约束的远程执行面：它能读、能写、能运行的一切，持有该 token 的客户端都能做到。因此 agent 在没有 token 时拒绝启动，包文档与示例配置都绑定 loopback 并通过 `ssh -L` 抵达目标。绑定可路由地址的运维方即是在暴露目标机器。

## Verification

包级测试套件锁定：注册表的解析、memo（记忆化）与资源释放；会话折叠及其写入路径；帧的编码、校验与限制；host 在临时目录上对两个 seam 的投影；以及通过真实进程内 connector 驱动的两个能力提供方，其中包括“绑定到不同 connector 的会话触达不同机器”的路由证明。transport 在真实 socket 上针对真实 agent 做端到端验证——握手拒绝、取消、进程流式输出、协议违规、重置连接的客户端，以及中途离开的客户端——并针对脚本化对端验证真实 agent 不会产生的那些应答。

## Alternatives considered

**把绑定放在内存中，在 agent 创建时播种。** 否决，因为一次会话的目标机器是这次会话的组成部分。内存映射在重启后丢失且对重放不可见，因此被恢复的会话会悄悄运行在部署默认值上——一台与 transcript 所描述的不同的机器。

**像 E2B 那样把 connector 做成部署级单例。** 否决，因为既定需求是用户配置若干 connector，然后在其中之一上开始会话。单例意味着每个目标都需要一个完整的 harness 进程。

**以 SSH 作为传输，驱动 `sftp` 和远程 shell。** 否决，因为它换来了凭据处理与加密，代价却是把每个文件系统操作重新实现为远程 shell 文本——从而失去原子发布、版本守卫和类型化错误——而且其 Windows 方案依赖运维方未必安装的 OpenSSH 服务器。在 TCP agent 前放一条 `ssh -L` 隧道，可以保留加密与凭据，而不必把操作集搬到 shell 上。

**WebSocket 上的 JSON-RPC。** 否决，因为它在两端引入 HTTP 升级和成帧依赖，却没有带来该 seam 所需的任何性质。这里没有浏览器，而同一条隧道两种方式都能工作。

**用单一通用的 `RemoteExecution` 服务取代 connector 注册表。** 否决，因为它把每个目标各不相同的两件事——是哪台机器、用哪种 OS 方言——坍缩进提供方标识，使一个部署无法同时提供 Linux 构建机和 Windows 实验机。

**在 agent 中重新实现文件系统与进程操作，而不是托管本地提供方。** 依据删除测试否决：第二份实现恰恰会在最难远程测试的地方与第一份产生偏离——原子 rename、版本标识、CRLF 处理、进程树终止——并且还需要自己的 Windows 移植。

**也在链路上提供终端服务。** 推迟，而非否决。PTY 分配、前台进程组探查和终端会话清理是一个深层原语，把它忠实投影到 wire 协议上，其设计量比该 seam 其余部分加起来还大。`spawnTerminal` 报告 `CONNECTOR_UNSUPPORTED`，因此把持久 shell 能力挂到 connector 上的部署会大声失败，而不是悄悄把 shell 运行在错误的机器上。

**把收集到的输出 spill 到目标上的文件并报告其路径。** 推迟。`dsh-tool-bash` 会把 spill 路径作为完整流的位置呈现给模型，而目标上的路径并不是 harness 能读回的路径。在取回操作存在之前，带诚实截断报告的有界内存尾部是更小的正确答案。
