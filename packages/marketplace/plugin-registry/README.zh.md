# @deepseek-ai/dsh-plugin-registry

[English](README.md) | 中文

plugin-registry [能力 seam](../../../docs/glossary.zh.md#capability-seam) 的 Service Definition。`PluginRegistry` 注册为 `ctx.pluginRegistry`，拥有一个面向 marketplace 目录来源的提供方注册表，以及所有消费方共享的搜索、查询与更新检测。[`plugin-registry-static`](../plugin-registry-static/README.zh.md) 是随仓库提供的 Service Provider；`dsh marketplace` 与设置中的 marketplace 标签页是 Consumer。

提供方只提供自己的完整目录，不做任何匹配：排序、版本选择与更新检测都在这里，因此每个来源对同一查询的回答方式一致。`registerProvider(provider)` 以提供方的 `id` 注册并返回 disposer；id 重复会明确失败，而不是遮蔽已注册的来源。

`catalog(signal)` 把每个已注册提供方的条目合并成一个以 id 为键的索引，并拒绝两个提供方都列出的插件 id，因此答案永远不依赖注册顺序。`search(query, signal)` 用大小写不敏感的子串匹配包名、显示名、描述与发布者，并按包名排序，因此同一查询在多次运行之间返回相同顺序。`get(id, signal)` 查询单个插件，`versions(id, signal)` 按从新到旧返回它的 release，而 `updates(installed, signal)` 报告版本与目录最新 release 不同的每个已安装插件——目录未列出的已安装插件会被跳过，因为手工安装的 tarball 并不是错误。

每次读取都在调用时解析目录。提供方拥有自己的缓存，因此 seam 不持有第二份可能与刚被编辑过的来源不一致的副本。这里不执行安装：`PluginRelease` 只指明一个 tarball，把它放进 profile 的是 [`plugin-install`](../plugin-install/README.zh.md)。release 从不携带 git ref，因为 git 依赖会在安装期间运行发布者的 `prepare` 脚本。

失败会抛出带 `PLUGIN_REGISTRY_DUPLICATE_PROVIDER`、`PLUGIN_REGISTRY_UNAVAILABLE`、`PLUGIN_REGISTRY_DUPLICATE_LISTING`、`PLUGIN_REGISTRY_EMPTY_RELEASES` 或 `PLUGIN_REGISTRY_UNKNOWN_PLUGIN` 的 `PluginRegistryError`；提供方会为来源失败补充自己的错误码。

## 模型体验

无，因为这个目录 seam 只回答 marketplace 查询，不注册提示词、工具、消息或提供方请求。

#### KV Cache 影响

无；本包从不组装模型输入。

## 已知限制与暂缓事项

- **没有可用性判定** —— 已注册的来源是运维人员配置的来源，因此读取不了的来源会让整次读取失败并指明问题所在，而不是退出合并并返回一份被悄悄截短的目录。
- **版本字符串只比较相等，不做排序** —— `updates` 报告与最新 release 的任何差异，因此本地安装的预发布版本会显示为可用更新。
- **release 顺序由提供方决定** —— seam 信任每个提供方“从新到旧”的排序，自己不排序，也不解析 semver。
