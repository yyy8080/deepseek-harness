# Agent Note: 插件 marketplace 是 profile 组合包之上的一层目录

Status: implemented

[English](2026-08-26-plugin-marketplace-catalog-and-install.md) | 中文

## Problem

[Profile 插件组合包](../architecture/2026-08-05-profile-plugin-bundles.zh.md)让树外插件变得可安装：声明了 `dsh.bundle` 的 npm 包会成为 `$DSH_HOME/profiles/<name>` 中的一个 patch 层，而 `dsh plugin --profile <name> add <package>` 转发给 pnpm 并调和层列表。这只回答了「包如何进来」，别的什么都没回答。没有办法知道存在哪些包，安装之前没有可供人判断的元数据，已安装的包来自哪里也没有记录，而且除了输入一个本人已经知道的包 specifier 之外，没有任何途径触达这一切。

## Decision

marketplace 是已有打包格式之上的一层目录、一份身份与一处信任展示。marketplace 插件就是同时携带 `dsh.plugin` package.json 段的普通 profile 组合包；这里没有第二种打包格式，没有 marketplace 专用的 manifest（元数据清单）文件，也没有 marketplace 专用的安装路径。`packages/marketplace/` 下的四个包划分了这些角色：

- [`plugin-manifest`](../../../../packages/marketplace/plugin-manifest/README.zh.md) 持有 `dsh.plugin` 的 schemastery schema（`displayName`、`description`、`publisher`、可选的 `homepage` 与 `capabilities`）、从包目录或目录记录中校验它的读取函数，以及 `DECLARED_CAPABILITIES_NOTICE`。
- [`plugin-install`](../../../../packages/marketplace/plugin-install/README.zh.md) 持有安装路径本身，由 `apps/cli/src/plugin.ts` 提取而来：`resolve(request): InstallSpec`、`install`、`uninstall`、`list`，以及 `dsh plugin` 逃生口仍在使用的原始 `forward`。
- [`plugin-registry`](../../../../packages/marketplace/plugin-registry/README.zh.md) 是 Service Definition `ctx.pluginRegistry`：一个提供方注册表，加上共享的 `catalog` / `search` / `get` / `versions` / `updates` 读取操作。
- [`plugin-registry-static`](../../../../packages/marketplace/plugin-registry-static/README.zh.md) 是面向单个静态索引 JSON 的 Service Provider，可通过文件系统或 HTTP 访问。

`dsh marketplace --profile <name> [--index <path-or-url>] search|show|install|uninstall|list|updates` 是 Consumer。它在一个裸 Cordis 上下文中挂载 `PluginRegistry` 与静态提供方，因此命令行读取目录所经过的 seam 与设置表层完全相同；它通过 `plugin-install` 安装，因此目录安装与手工输入的 `dsh plugin add` 留下完全相同的 profile。`--index` 缺席时由 `$DSH_MARKETPLACE_INDEX` 提供索引；两者都不存在会明确失败，而不是给出一个空目录。

### 安装只接受 tarball

`PluginRelease` 指明的是打包好的 npm tarball 的绝对文件系统路径或 `https:` URL，而绝不是 git ref。git 依赖会在安装期间运行发布者的 `prepare` 脚本，而 pnpm 10 会将其阻断，直到有人把确切的包键加入 `allowBuilds`——这等于在一个人正想安装东西的时刻，要求他为一段没人读过的构建脚本背书。打包好的 tarball 已包含构建产物，因此安装只复制字节、不运行任何脚本。`dsh plugin` 逃生口仍然接受 git specifier 并打印如何加入允许列表；marketplace 路径不提供这个选项。

### 声明的能力是声明，不是沙箱

`capabilities` 记录发布者所说的插件行为：它注册的工具名、文件系统与网络各自的 `none` | `read` | `write`，以及一个 subprocess 布尔值。没有任何环节读取这些字段来限制任何东西。已安装插件以 profile patch 层的身份挂载，拥有与内置插件相同的权限，因此 `DECLARED_CAPABILITIES_NOTICE`——*Declared by the publisher and not enforced: an installed plugin runs with full harness authority regardless of what it declares*——放在 `plugin-manifest` 中，而每个打印能力的表层都会一并打印它。把这句话放进 schema 包，正是为了避免命令行与设置面板对同一字段给出两种不同的承诺。

### 来源记录属于 profile，而不是包的自我声明

`install` 把 `dsh.marketplace.installs` 写进 profile 自己的 package.json，以已安装包名为键：`origin`（`marketplace` 或 `tarball`）、解析后的 tarball 位置、存在时的目录版本，以及 `installedAt` 时间戳。`uninstall` 删除该条目，`list` 报告它。由于记录属于 profile，即使目录本身之后发生变化，审计仍能区分目录安装与手工提供的文件。

### 安装在下一次启动时生效

profile 启动器在启动时读取一次 `dsh.profile.bundles`，并且只让 `cordis.patch.yml` 保持实时生效，因此安装组合包并不会把它挂载进正在运行的进程。每个安装结果都带有 `bundle` 标志，命令行也会明确说明（`relaunch dsh --profile <name> to use it`）。卸载在反方向上同理。

## Spike conclusions

**S1——打包好的 tarball 可以在无任何提示的情况下装进干净的 profile。** 先对样例插件执行 `pnpm pack`，再在空的 `DSH_HOME` 中执行 `dsh marketplace install`：它会按模板初始化 profile、安装 tarball、把该包追加进 `dsh.profile.bundles`，并成功退出。没有 `prepare` 脚本运行，pnpm 也从不索要 `allowBuilds` 条目，因为打包好的 tarball 没有可被阻断的构建步骤。这次安装耗时几百毫秒，对文件系统 tarball 无需网络——这也是包测试使用真实 pnpm 而非桩件的原因。

**S2——重启要求真实存在，并且在每个需要说明的位置都写明了。** 安装之后的 `--dump-config` 会显示新的 `# == <package>` 层及其配置行；而已经在运行的 `dsh` 进程不会。安装结果的 `bundle` 标志、命令行的收尾输出、各包 README 与示例 README 都说明了这一点。

## Alternatives considered

- **专用的 marketplace 包格式**（自成一体的 `dsh-plugin.json` 或 tarball 布局）：否决，因为 harness 中插件能成为的东西本来就只有一种——patch 会被 profile 启动器应用的组合包。第二种格式需要自己的解析器、自己的加载路径和自己的存在理由；而 `dsh.plugin` 段只是给本来就能用的格式补上目录元数据，并且无论包有没有发布到任何地方，它都可以携带这个段。
- **marketplace 专用的安装路径**，自行取回并解包：否决，因为那会产出一个内容并非 pnpm 写入的 profile，此后该 profile 中的每次 `dsh plugin` 操作都会基于一份并不描述实际目录树的 lockfile 进行推断。走同一条 `pnpm add` 能让 profile 的 `node_modules` 只有一个所有者。
- **在 v1 就强制执行声明的能力**：否决，因为那是运行时兑现不了的承诺。patch 层会在 harness 进程中挂载任意 Cordis 插件；强制执行意味着一个真正按能力划分权限的插件宿主，那是比一层目录大得多的改动。声明它们不被强制执行，并用一句共享措辞讲清楚，才是诚实的做法；一个看起来像限制却并不是限制的能力字段，比没有这个字段更糟。
- **由提供方负责搜索与排序**：否决，因为那样每个提供方对同一查询的回答方式都会不同，合并后的目录也就没有确定的顺序。提供方返回自己的完整目录；匹配、排序、版本选择与更新检测都在 seam 中。
- **在 seam 中缓存目录**：否决，因为静态索引是有人编辑的文件或有人拉取的 git 检出，缓存副本会用那次编辑之前的状态作答。提供方持有自己需要的任何缓存；seam 在调用时解析。
- **直接读取 git 远端的提供方**：暂缓而非否决。已检出的索引文件与 HTTP 提供的索引文件用同一种文档格式覆盖了两种部署形态；在提供方内部克隆会引入一份工作副本生命周期，而那将由 seam 承担。
- **给 `plugin-inventory` 补上来源信息**：本次改动否决。该服务投影的是 Loader 条目，其模块标识是组合包 patch 挂载的插件模块，而不是 profile 安装的组合包包名。把两者关联起来需要一份从 patch 行回溯到所属组合包的映射，那是 Loader 侧的改动而非 marketplace 侧的改动；`plugin-install` 的 `list` 依据 profile manifest 报告来源信息，而记录本来就存在于那里。

## Testing

包测试覆盖全部四个包，在 `src` 上达到完整的语句、分支与函数覆盖率，并针对临时 profile 目录使用真实 pnpm 而非桩化的包管理器。`apps/cli/tests/marketplace-install.e2e.ts` 通过构建后的 CLI 固定整条流程：打包样例、search、show、安装进一个用完即弃的 `DSH_HOME`、断言 profile manifest 的 `dsh.profile.bundles` 与 `dsh.marketplace.installs`、断言已安装的层出现在 `--dump-config` 中、卸载，并断言它已消失。拒绝路径在两端都有覆盖：无效的 `dsh.plugin` 段会让 `parsePluginSection` 明确失败，而无效或版本不匹配的索引文档会让静态提供方失败并指明索引路径。

## Consequences

- 一个人可以找到插件、读到它由谁发布、声称做什么，把它装上，并在之后看到它来自哪里——全程不必离开命令行，也不必事先知道包 specifier。
- `apps/cli/src/plugin.ts` 现在是 `plugin-install` 之上一层承载启动器事实的包装，因此 marketplace 与逃生口在如何对待 profile 上不可能出现分歧。
- 目录是一份由人手工维护的 JSON 文档。没有发布流水线、没有签名、没有哈希校验、也没有发布者命名空间，因此对一条目录条目的信任完全落在对索引文件所有者的信任之上。
- 只支持 pnpm，也只支持 tarball；真正需要构建步骤的插件无法发布到 marketplace 索引。

## Deferred

设置中的 **Marketplace** 标签页（一个位于 `ctx.pluginRegistry` 与 `plugin-install` 之上的 Host Remote，以及一个与插件清单标签页并列的 `settings.plugins.tab` 占位）不在本次改动中，缺少的一个事实正是原因：Host 插件无法得知自己运行在哪个 profile 中。`dsh --profile <name>` 在启动器中解析 profile 目录，只把 `ctx.cmdlineArgs` 与环境快照提供给配置树，因此被组合进来的插件内部没有任何东西知道安装应当写入 `$DSH_HOME/profiles` 下的哪个目录。一个在 web-app 组合包静态 patch 中写死 profile 名称的网关，只会装进那份 patch 恰好携带的名字，而不是正在运行的 profile——这是一个悄无声息的错误目标，也正是这个 seam 绝不能有的失效模式。像[应用持有命令行](../architecture/2026-08-06-app-owned-command-line.zh.md)暴露调用期取值那样，由启动器以启动服务的形式暴露正在运行的 profile，是这件事的前提，而那是对 `packages/boot` 的改动，不是对 marketplace 的改动。只读标签页作为中间步骤被否决了：一个只能浏览、无法安装的 marketplace，教给人的是「按钮不见了」，而不是「该操作暂不可用」。在此之前命令行就是完整的 Consumer，`apps/cli/tests/marketplace-install.e2e.ts` 中的 `--dump-config` 记录就是该流程的整机证据。签名、哈希校验、发布流水线与在线插件编辑器同样不在范围内。
