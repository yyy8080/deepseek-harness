# Agent Note: 证明连接器还活着，并在它上面开一场对话

Status: implemented

[English](2026-08-27-connector-liveness-and-bound-chat.md) | 中文

## 问题

[下载门户](../architecture/2026-08-26-connector-download-portal.zh.md)让机器完成了登记与接入，连接器页面也能报出它的名字。但用户接下来会问的两个问题，它一个都答不了。

**这条链路还活着吗？** 页面显示 `attached`——这是 agent 升级握手完成那一刻记下的事实，可能已经是几小时前。睡眠的笔记本、被杀掉的目标进程、断掉却没关闭 socket 的网络：三种情况都会一直显示 `attached`，直到传输层碰巧发觉。一个报告上一次事件而非当前世界的状态，比没有状态更糟，因为用户会照着它行动。

**我能用它吗？** 把会话绑到连接器，需要一份挂载 `dsh-fs-connector` 与 `dsh-subprocess-connector` 的 agent preset，以及会话上的一条 `connector/bound` 事件。这两样在浏览器里都够不着：部署没有附带这样的 preset，`session.create` 也无从指名一个连接器。门户那篇 Agent Note 暂缓的正是此事。

## 决策

两个 Remote 调用加一份随部署附带的 preset，并且在每一条本来只能靠猜的路径上都大声拒绝。

### 存活性是一次往返，绝不是一个状态字段

`connectorPortal.probe({ enrollmentId })` 在活链路上解析该接入自己的 `workdir` 并对结果做 stat，然后报出 `latencyMs`、**目标**解析出的路径，以及它是否仍是一个目录。用两次调用而非一次：单靠 `resolve` 从一个路径字符串就能答出来，而 `stat` 迫使目标真的碰一次它的文件系统，这才是调用方真正在问的能力。之所以拿 workdir 当参数，是因为它是目标自己在接入时声明的路径，因此探活不需要用户提供任何输入，也不会因为指了一个从来不存在的名字而失败。

`ConnectorProbeReport` 是一个带判别式的结果，而非抛出的错误：`alive: true` 携带测量值，或者 `alive: false` 携带 `unknown-enrollment`、`not-attached`、`link-failed` 之一，外加一条点明下一步动作的消息。`not-attached` 直接由账本回答、不碰传输层，因为根本没有可探的东西。

门户用 `Promise.race` 对上一个由 abort 驱动的拒绝，自己施加期限。中止一次连接器调用并**不会**让它完成——传输层向目标发一帧取消，然后继续等目标的回答，而一台已经不再回答的目标永远不会发出这个回答。这恰恰是存活探测存在的意义所在，所以期限必须落在调用之上。`probeTimeoutMs`（10 秒）是可配置字段。

### 对话在创建时绑定，否则在任何东西存在之前就被拒绝

`session.create` 接受 `connectorId`。网关**先**校验注册，若 id 指向不存在的东西就回 `connector-not-registered`，否则给刚创建的会话追加一条 `connector/bound` 事件。选择创建后绑定而不是走创建参数，是为了把会话的执行世界留在这条 seam 其余部分本就读取的地方——日志——而不是引入一个投影还得去调和的第二权威。

这类会话请求的 `cwd` 是**目标**文件系统里的路径。因此 `ensureSession` 取 `cwdIsLocal: false` 并跳过它的 `mkdir`：在宿主机上创建那个绝对路径，只会留下一个目录，遮蔽着这场对话永远不会读的东西。

`ConnectorRequest` 新增了可选的 `connectorId`，其优先级高于会话绑定与部署默认值。它面向的是**关于**某个连接器、而非身处某场对话之中的调用方——比如指名要检查哪台机器的探活。能力 provider 绝不设置它，因为 provider 必须解析调用方会话自己的执行世界。

### 执行世界搬走了，它之上的一切都没动

随部署附带的 `connector` preset 就是 `standard`，只换掉一个 group。一层覆盖 `fs`、`subprocess`、`shell` 与 `settings` 的 `isolate` 域里装着 `dsh-fs-connector`、`dsh-subprocess-connector`、`dsh-bash-local`，以及与 provider 无关的 `tool-bash` / `tool-fs` / `tool-fs-search` 消费者。这层域正是让替换按对话生效、而不是进程全局生效的东西：宿主平面保留它带沙箱的本地 provider，而这份 preset 上的两场会话抵达两台不同的机器。

`settings` 进入这层域的理由与另外三个不同——`dsh-bash-local` 会注册 `shell` 设置命名空间，而宿主自己那个带沙箱的执行器已经占用了它，并且拒绝第二次注册。

有三行是刻意缺席的。委派会从**宿主**的名册里组合出子 agent，于是 subagent 会悄悄跑在错误的机器上。`skill-filesystem` 在本地根目录下发现技能，而那不是这场会话的文件所在之处。`bash-local` 上没有施加沙箱，因为宿主机的约束机制对一台通过链路抵达的目标什么也约束不了；一场连接器会话就是对目标的 shell 访问权，而这在登记该机器时就已经授予了。

### 可用性是被检查出来的，不是被假定的

`connectorPortal.list()` 报出 `chat: ConnectorChatAvailability`。只有当 preset 名册里确实有配置的 `chatPreset`，**并且**该 preset 的组合文本真的挂载了 `@deepseek-ai/dsh-fs-connector` 时，它才是 `ready`；否则它携带一个拒绝原因（`no-preset-service`、`preset-missing`、`preset-not-connector`）与一条消息。移除了该 preset、或把它改成了本地版的部署，会在页面上直说，而不是悄悄把对话跑在宿主机上——那是这个特性唯一可能造成、而用户又不会察觉的失败。

## 涉及的文件

`packages/host/connector-portal` 拥有 `probe` 与 `chatAvailability`；`packages/host/apiproxy` 拥有 `session.create` 上的 `connectorId`；`packages/connector/connector` 拥有 `ConnectorRequest` 的新字段；`packages/client/ui-settings-connectors` 拥有两个按钮；`packages/client/runtime` 拥有 `sessions.startConnectorSession`；`apps/cli/config/agent-presets/connector` 是那份组合，`packages/bundle/web-app/cordis.patch.yml` 指名了它。

## 已考虑的备选方案

**从传输层自己的 socket 状态报告存活性。** 否决：socket 开着只能证明 TCP 连接还在，不能证明 agent 进程仍在服务。一条穿过已遗忘映射的 NAT 的半开连接，在这一侧可以无限期地读作「开着」。而这个区别恰恰只在用户所问的那种情形下才要紧。

**在连接器线协议里加一个专门的 `ping` 帧。** 按删除测试否决。对 workdir 做 `resolve` + `stat` 已经跑通了完整的请求/响应路径外加目标的文件系统，且不增加协议表面、不增加版本协商、不留下任何需要保持兼容的东西。一个 ping 证明的严格更少。

**持续轮询存活性并显示实时指示。** 本次否决。它把一次用户发起的往返变成每个打开的连接器页面上、每一行的后台流量，而它能显示的诚实答案，新鲜度依然只到上一次轮询为止。让用户在真正在意时显式动作，既更便宜也更不误导。

**持久化探活结果。** 否决：存下来的延迟就是这个特性要消除的那个陈旧状态缺陷，只是下沉了一层。

**在会话绑定时把宿主的 `ctx.fs` 与 `ctx.subprocess` 换成连接器版。** 否决。宿主平面的 provider 带沙箱，并且承载着连接器操作集所没有的终端支持；进程级替换会把约束从每一场会话上拿掉，包括那些跑在宿主机上的会话。`isolate` 域给出同样的替换，而爆炸半径正是这个特性真正需要的大小。

**通过写在会话头上的创建参数来绑定。** 否决，因为那样绑定就有了两个权威——头与 `connector/bound` 事件——而每个读取方都得知道在恢复的会话上哪个说了算。

**允许模型或用户在对话中途切换连接器。** 暂缓。会话的历史是在某一个执行世界下产生的，中途改绑会留下这样一份记录：早先的文件读取描述的是后来的读取根本看不见的机器。创建时刻是唯一答案没有歧义的时刻。

**只要存在名为 `connector` 的 preset 就提供开对话动作。** 否决：preset 是可以被改的。去读组合里那一行连接器版文件系统，才把「一份名字对的 preset」变成「一份真的搬走了执行世界的 preset」。

**连接器 preset 缺失时回退到 `standard`。** 作为可选项里最坏的失败被否决：对话会跑在宿主机上，而页面却说它跑在用户自己的机器上。

## 测试

包内用例覆盖门户探活的四种结果，都对着一条真实链路，其中包括一台握着连接却停止回答的目标——正是它钉住了那个期限，因为没有那场 race，这条用例是挂起而不是失败。网关用例覆盖绑定、目标侧 `cwd` 下被跳过的本地 `mkdir`，以及两条拒绝路径。组件测试把两个按钮走过成功、宿主拒绝与动作被扣下这几种状态。装配后的 Web 组合 e2e 用 `connector` preset 组合出会话，断言该会话的 `fs` 与 `subprocess` 是连接器版的类，而宿主平面与它旁边的一场 `standard` 会话都毫发无损。

## 后果

连接器页面现在能回答这两个问题了，而第二个问题对部署方零成本——preset 随部署附带，web bundle 指名了它。

一场连接器对话没有工作区。它的 `cwd` 是目标的 workdir，而目录选择器、项目根目录，以及其余一切以本地路径为键的东西都不适用于它。会话本身可用；围绕它的工作区便利设施是缺席，而不是出错。

探活测的是某一时刻的一次往返。此刻能回答的机器，下一秒就可能消失，所以结果是作为一次带时间戳的测量呈现的，而不是让那一行采纳为自己的状态。
