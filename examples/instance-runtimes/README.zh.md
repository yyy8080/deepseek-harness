# instance-runtimes

[English](README.md) | 中文

每个会话都运行在自己隔离的 harness 运行时中，而浏览器仍通过原有的那一条连接访问它们全部。新建对话即分配一个运行时；该对话的 shell、文件系统和会话日志从它的第一个事件起就位于其中。

组成部分为 [instance 能力缝](../../packages/instance/instance/README.zh.md)、其[本地进程 Provider（服务提供者）](../../packages/instance/instance-local-process/README.zh.md)、每个运行时启动的 [worker bundle（打包层）](../../packages/bundle/worker/README.zh.md)，以及在它们之间路由的[多路复用网关](../../packages/instance/instance-gateway/README.zh.md)。

## 运行

先构建：每个运行时都是启动本仓库已构建 `dsh` 的子进程。

```sh
pnpm run build
pnpm dsh web --patch examples/instance-runtimes/cordis.yml
```

浏览器界面在 http://127.0.0.1:3082 响应。驱动对话需要 `DEEPSEEK_API_KEY`，启动控制平面则不需要。

每个新对话会在 `$DSH_HOME/instances/<instanceId>/` 下分配一个运行时，其中包含该运行时自己的 `home`（它的 `DSH_HOME`）与 `workspace`（它的工作目录，也是其 shell 工具唯一能触及的目录树）。这些运行时随控制平面一同停止；它们的会话日志会保留下来供检查。

## 观察要点

会话 id 按运行时加上命名空间——`inst-1~session-…`——这正是单条连接如何跨多个隔离存储寻址会话的方式。连续创建的两个对话会落在不同的运行时上，报告不同的 `cwd`；在其中一个里执行的命令对另一个不可见。

`maxInstances: 4` 将本示例限制为最多四个存活运行时。在 overlay（覆盖层）中设置 `placement: shared`，可改为把所有对话都放进同一个运行时，以对话之间的隔离换取单次冷启动。
