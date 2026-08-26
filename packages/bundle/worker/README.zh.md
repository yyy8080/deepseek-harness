# @deepseek-ai/dsh-worker

[English](README.md) | 中文

隔离运行时组合包：浏览器界面的宿主一半，去掉浏览器。loopback 上一个 `/api` 网关，没有前端产物，没有 `dsh.client` 名册，没有 URL 提示行，没有默认浏览器转交。控制平面监督这个进程并经由该网关访问它；这里没有任何东西直接服务于人。

以 `worker` profile 启动它——`dsh --profile worker` 在这个 patch 层之下组合 `@deepseek-ai/dsh-base`。通常启动它的是[本地进程 instance Provider](../../instance/instance-local-process/README.zh.md)。

## 约定

- 服务器绑定 `127.0.0.1` 上由操作系统分配的端口，并且不声明任何受信任主机，因此 `/api` 防护会拒绝每一个非 loopback 的 `Host`。worker 只能从它自己所在的机器、由它的监督者访问。
- 就绪信号是 instance seam 的端点握手。设置了 `endpointFile` 时——Provider 以 `DSH_INSTANCE_ENDPOINT_FILE` 传入——插件会在整棵 Loader 树结算之后把一个完整的 `{"origin":"http://127.0.0.1:<port>"}` 文件重命名到位，因此监督者绝不会看到只挂载了一半的 worker。未设置时，则改为打印同一个 origin。
- 启动失败，或启动过程中整棵树被释放，都不会发布任何东西：监督者观察到的是进程退出，而不是一个陈旧端点。
- 隔离来自 worker 自己的 `DSH_HOME` 与工作目录，两者都由监督者提供。会话日志、存储、设置和 shell 状态永远不会离开那棵目录树。
- 本组合包不挂载 agent preset 名册。会话运行在 `@deepseek-ai/dsh-base` 组合出的进程级 agent（智能体）平面上，因此 `session.create` 不会把任何 preset 选择带进 worker。

## 模型体验

### 直接消费方

#### 模型看到的内容

一个提示词分区 `app:worker-surface`，说明该运行时是专为本次会话分配的，且它的文件系统、harness home、会话存储和 shell 状态均为其私有。这个分区的存在是为了让模型不去提议检查用户的机器——它根本访问不到。在自带方位说明的组合中，用 `surfaceContext: false` 关闭它。

#### Token 影响

每次请求一个简短的固定分区，量级约六十个 token。

#### KV Cache 影响

该分区文本在 worker 的整个生命周期内保持不变，因此它绝不会使请求前缀失效。

## 已知限制与暂缓事项

- 没有 `api-remotes` 行，因此浏览器用于目标、消息反馈和插件清单的 Typert RPC 接口在 worker 内不可用。要代理这些接口的控制平面必须从自己的平面提供它们，或在这里加上该行。
- 没有 agent preset 名册（见上）。在 worker 内做按对话组合，需要 preset 行以及 web 界面所带的对应宿主平面禁用项。
- worker 的输出去往监督者的 stdio 配置所指向的地方；本组合包除了无监督时的就绪提示行之外不打印任何内容。
