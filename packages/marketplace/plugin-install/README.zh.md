# @deepseek-ai/dsh-plugin-install

[English](README.md) | 中文

把一个包放进 `dsh --profile` 组合的唯一路径，无论请求来自 marketplace 表层、`dsh marketplace` 命令行，还是 `dsh plugin` 这个原始逃生口。每个操作最终都归结为同样的两步——在 `$DSH_HOME/profiles` 下的 profile 目录中运行 pnpm，然后按实际安装状态调和 `dsh.profile.bundles`——因此目录安装与手工输入的安装留下完全相同的 profile。

`resolve(request)` 把 `InstallRequest` 转换成 `InstallSpec`：它把相对 tarball 路径锚定到调用方的工作目录，解析 profile 目录，并构造要记录的来源信息。默认值只在这一处填充，因此调用方可以在安装执行前打印或确认这次安装将做什么。随后 `install(spec)` 运行包管理器，判定这次运行安装出的依赖名，调和层栈，并记录来源信息。`uninstall(target, id)` 是它的逆操作，`list(target)` 报告 profile 的树外依赖及其版本、`dsh.plugin` 元数据与来源信息，而 `forward(target, args, cwd, warn)` 则把原始 pnpm 参数交给 profile，用于 marketplace 动词未覆盖的操作。

调和以实际安装状态为准，而不是以依赖差异为准：解析后声明了 `dsh.bundle` 的依赖会加入 `dsh.profile.bundles`，而不再声明的依赖——被移除，或升级到一个去掉了该声明的版本——会离开该列表。内置模板组合包不是依赖，因此从不被改动。新加入却未声明 bundle 的依赖会作为普通依赖安装，并通过 `warn` 报告。

来源信息保存在 profile 自己的 manifest（元数据清单）的 `dsh.marketplace.installs` 下，以已安装包名为键，记录 `origin`（`marketplace` 或 `tarball`）、解析后的 `tarball` 位置、存在时的目录 `version`，以及 `installedAt` 时间戳。它是 profile 关于自己取回了什么的记录，而不是包对自身的声明，因此即使目录之后发生变化，后续审计仍能区分目录安装与手工提供的文件。

安装不会改变正在运行的树。profile 启动器在启动时读取一次 `dsh.profile.bundles`，并且只让 `cordis.patch.yml` 保持实时生效，因此新安装的层会在下一次启动时挂载——每个安装结果都通过它的 `bundle` 标志说明这一点。失败会抛出带 `PLUGIN_INSTALL_PACKAGE_MANAGER_MISSING`、`PLUGIN_INSTALL_FAILED`、`PLUGIN_INSTALL_NO_PACKAGE` 或 `PLUGIN_INSTALL_NOT_INSTALLED` 的 `PluginInstallError`；包管理器失败会引用 pnpm 的合并输出，因为 pnpm 会把若干最常见的诊断打印到标准输出而非标准错误。

## 模型体验

无，因为本包只把包安装进 profile 目录，不注册提示词、工具、消息或提供方请求。

#### KV Cache 影响

无；本包从不组装模型输入。它安装的层会在下一次启动时挂载，该层注册的内容各自拥有自己的影响。

## 已知限制与暂缓事项

- **只支持 pnpm** —— 可执行文件名是固定的，`PATH` 上没有 pnpm 的主机会以 `PLUGIN_INSTALL_PACKAGE_MANAGER_MISSING` 失败。
- **不做完整性校验** —— 安装会取回 tarball 位置上的任何内容；这里没有哈希、签名或发布者证明校验，因此信任完全落在目录与传输之上。
- **没有更新操作** —— 用较新版本覆盖较旧版本就是一次普通安装，本包不比较版本，也不迁移插件自身的状态。
- **重装已安装版本靠记录的 specifier 识别** —— 这类运行不会移动任何依赖，因此当 profile 已经在两个名字下列出同一 specifier 时，会以 `PLUGIN_INSTALL_NO_PACKAGE` 明确失败，而不去猜调用方指的是哪一个。
