# @deepseek-ai/dsh-plugin-manifest

[English](README.md) | 中文

package.json 中的 `dsh.plugin` 段：它的 [schemastery](../../../vendor/schemastery) schema、校验它的读取函数，以及每个表层在展示声明能力时都要一并打印的那句话。marketplace 插件就是同时携带该段的 profile [组合包](../../bundle/README.zh.md)；该段提供了判断一条目录条目所需的信息——`displayName`、`description`、`publisher`、可选的 `homepage` 以及 `capabilities`。

`capabilities` 声明 `tools`（插件注册的工具名）、取值为 `none` | `read` | `write` 的 `filesystem` 与 `network`，以及布尔值 `subprocess`。所有字段均为必填，因为一行渲染出空白名称或空白发布者的目录条目是任何人都无法判断的条目。

`parsePluginSection(value, source)` 校验单个段，`parsePluginManifest(value, source)` 校验 `id` 与段内字段并列的整条记录——也就是目录索引内嵌的形式——而 `readPluginManifest(packageDir)` 读取并校验包自身的 package.json。两个解析函数都逐字段投影，而不是原样返回校验后的输入，因此目录条目的 release 列表不会泄漏进插件元数据。没有 `dsh.plugin` 段的包不是 marketplace 插件：`readPluginManifest` 返回 `undefined`，而不是凭空编造元数据。失败会抛出带 `PLUGIN_MANIFEST_INVALID`、`PLUGIN_MANIFEST_UNNAMED` 或 `PLUGIN_MANIFEST_UNREADABLE` 的 `PluginManifestError`，并且始终指明承载错误值的文件或目录。

`DECLARED_CAPABILITIES_NOTICE` 是那句共享措辞：*Declared by the publisher and not enforced: an installed plugin runs with full harness authority regardless of what it declares.*（由发布者声明且不被强制执行：无论声明了什么，已安装插件都以完整的 harness 权限运行。）它放在这里，是为了让命令行与设置面板不会对同一字段给出两种不同的承诺。

## 模型体验

无，因为本包只校验发布者元数据，不注册提示词、工具、消息或提供方请求。

#### KV Cache 影响

无；本包从不组装模型输入。

## 已知限制与暂缓事项

- **`capabilities` 是声明而非限制** —— harness 中没有任何环节读取这些字段来约束已安装插件，插件以 profile patch 层的身份挂载并拥有完整权限。展示这些字段的消费方必须同时展示 `DECLARED_CAPABILITIES_NOTICE`。
- **没有发布者身份** —— `publisher` 是自由文本，背后没有签名、命名空间预留或来源证明，因此在发布流水线出现之前它并不标识任何人。
