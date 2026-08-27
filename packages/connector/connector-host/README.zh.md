# @deepseek-ai/dsh-connector-host

[English](README.md) | 中文

connector（连接器）的目标端：一台机器所提供的执行世界、为其提供服务的 TCP agent，以及把 harness 宿主机自身注册为进程内 connector 的插件。这个世界是一个私有 Cordis 应用，其中只有 [`@deepseek-ai/dsh-fs-local`](../../fs/fs-local/README.zh.md) 和 [`@deepseek-ai/dsh-subprocess-local`](../../subprocess/subprocess-local/README.zh.md)，并被投影到 connector 操作集上。复用已发布的本地提供方正是关键所在：无论 agent 运行在 harness 旁边还是另一台机器上，文件系统标识、原子发布、行尾处理、进程树、PATH 查找和 Windows 进程终止都只保留一份实现。

## 配置

挂载该插件即把这台机器注册为一个 connector。

| 字段 | 含义 |
|---|---|
| `id` | 会话绑定所用的标识符。默认为 `local`。 |
| `workdir` | 绝对默认工作目录。默认为 harness 进程的 cwd。 |

`dsh-connector-agent` 可执行文件改为从命令行获取相同信息，且有两种模式：

```
dsh-connector-agent --host 127.0.0.1 --port 8765 --workdir /srv/work --token <secret>
dsh-connector-agent --attach https://harness.example/connector/attach --label laptop --workdir /srv/work
```

当 `DSH_CONNECTOR_TOKEN` 中已有该密钥时可省略 `--token`，部署正是以此避免把密钥暴露在进程列表中；当 `DSH_CONNECTOR_ATTACH` 已指明端点时可省略 `--attach`。缺失或为空的密钥会被拒绝；不存在免认证模式。`--host` 与 `--port` 描述的是绑定，`--label` 则是把机器名报给某个部署，因此把其中之一与另一种模式混用会在解析期被拒绝，而不是被默默忽略。

## 运行 agent

agent 是纯 Node 程序，自身没有原生依赖，因此同一条命令在两个目标族上都适用。在目标机上安装已构建的包，或抓取部署所提供的单文件 bundle（见下），然后：

- **Linux/macOS** —— `DSH_CONNECTOR_TOKEN=… dsh-connector-agent --workdir /srv/work`。保持默认的 loopback 绑定，并用 `ssh -L 8765:127.0.0.1:8765 user@target` 访问；或在 systemd 下运行，把密钥放进 `EnvironmentFile`。
- **Windows** —— `$env:DSH_CONNECTOR_TOKEN='…'; dsh-connector-agent --workdir C:\work`。路径、`file:` URI、PATHEXT 查找和进程树终止都遵循 Windows 规则，因为本地提供方已经实现了它们；agent 在握手中报告 `windows`，因此客户端会使用同一路径方言进行计算。

## attach 模式

listen 模式要求目标机可被访问。attach 模式反了过来：agent 主动拨向部署的 attach 端点，把连接升级为 `dsh-connector` 协议，并在自己打开的这条 socket 上被服务。此时目标机不需要入站端口、不需要隧道、也不需要 DNS 名称——只需要能向该部署发出出站 HTTP。[`dsh-host-connector-portal`](../../host/connector-portal/README.zh.md) 生成的启动脚本正是为此。

协议本身不变。agent 在升级请求中出示自己的 token，因此部署在接受任何一个协议字节之前就知道是哪条登记记录拨了进来；随后部署发送与在被拨 socket 上完全相同的 `hello`，携带同一份密钥，agent 以 `ready` 应答。两个方向依然都经过认证，所服务的世界也完全一致。拒绝从 HTTP 状态码读出：agent 会报告部署给出的原因，并按固定延迟重试，因此被吊销的登记记录或重启过的 harness 会显现在 agent 自己的输出里，而不是无声无息。

## 打包好的 agent

`pnpm run build` 还会产出 `lib/agent-bundle.js`，以 `@deepseek-ai/dsh-connector-host/agent-bundle` 导出：这是一个文件，在纯 Node 下运行，身边不需要任何 `node_modules`。它的存在是为了让部署能把 agent 通过 HTTP 送给一台只装了 Node 的机器。

原生模块无法装进单个文件，因此该 bundle 把 [`node-pty`](https://www.npmjs.com/package/node-pty) 与 [`koffi`](https://www.npmjs.com/package/koffi) 解析到构建期的桩模块，被调用时即抛错。后果是确切的：该 bundle 完整提供文件系统与一次性命令，而 PTY 分配——本来也不在操作集内——不可用，只被终端拉起使用的 Windows 进程检查器同样不可用。需要这些能力的目标机改从 registry 安装该包。

## 行为

- **握手** —— 客户端发送带协议修订号和密钥的 `hello`；agent 以带自身修订号、OS 族和工作目录的 `ready` 应答，或报告失败并关闭 socket。密钥比较是常数时间的。握手完成前不接受其他任何内容。
- **分发** —— 每个 `call` 帧在其自己的 `AbortController` 下针对私有世界执行一次操作，因此一个 `cancel` 帧恰好中止那一次调用。位置参数在到达时被校验，因为对端是 wire 边界而非类型化调用方。
- **进程** —— 客户端在 spawn 调用中为每个进程分配标识符，因此 agent 绝不会在客户端观察者存在之前投递通知。两条输出流始终以 base64 投递；仅在两条管道流都结束后才宣告 exit，随后单独宣告进程树退出。
- **客户端离开** —— 关闭连接会中止该客户端在途的调用，并终止它启动的进程树。客户端无法通过断开连接把工作遗留在目标机上继续运行。
- **暴露面** —— 该密钥授予对所服务世界的完整文件与命令访问权限。listen 模式下该可执行文件默认绑定 loopback，任何更大范围都需要运维方自备传输通道——`ssh -L` 隧道或私有网络；没有任何东西会隐式放宽该绑定。attach 模式下由目标机自己打开连接，因此它所接受的暴露面是一个指名的部署，而不是一个端口。

## 模型体验

间接地，通过 [`dsh-fs-connector`](../fs-connector/README.zh.md) 和 [`dsh-subprocess-connector`](../subprocess-connector/README.zh.md)——它们渲染这台机器应答的一切——以及 [`dsh-connector`](../connector/README.zh.md) 向系统提示词贡献的目标描述。

#### KV Cache 影响

无直接失效；被点名的消费方拥有任何请求前缀变更。

## 已知限制与暂缓事项

- **传输层没有加密** —— 帧以明文通过 TCP 传输。范围超出 loopback 的部署应自行提供隧道；agent 既不终止 TLS，也不校验对端证书。
- **每个 agent 只服务一个世界** —— workdir 和 OS 族在启动时固定。要服务多个根目录就要运行多个 agent。
- **没有终端** —— agent 服务文件系统和受管进程树；PTY 分配不属于该操作集，因此 [`dsh-terminal-bash`](../../terminal/terminal-bash/README.zh.md) 无法在 connector 上运行。
- **重启会丢弃活跃进程** —— 进程句柄归属于一条连接，agent 不保存它们的持久记录。重启 agent 或丢失 socket 会结束它启动的所有进程树。
