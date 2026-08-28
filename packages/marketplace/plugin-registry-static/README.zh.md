# @deepseek-ai/dsh-plugin-registry-static

[English](README.md) | 中文

[`plugin-registry`](../plugin-registry/README.zh.md) 面向单个静态索引文档的 Service Provider：一个列出全部插件及其 release 的 JSON 文件，可通过文件系统或 HTTP 访问。在发布流水线出现之前，这一个文档就是 marketplace 的全部后端。该插件以提供方 id `static` 注册。

配置：`index` 是 `http(s):` URL、`file:` URL 或文件系统路径，`base` 是相对 `index` 路径所依据的目录，默认为进程工作目录。

```yaml
- @deepseek-ai/dsh-plugin-registry
- @deepseek-ai/dsh-plugin-registry-static:
    index: ./examples/marketplace/index.json
```

文档声明 `version: 1` 与一个 `plugins` 数组。每个条目在 [`plugin-manifest`](../plugin-manifest/README.zh.md) 校验的 `dsh.plugin` 字段旁携带 `id`（npm 包名），另有一个按从新到旧排序的 `releases` 数组，元素为 `{ version, tarball, publishedAt? }`。相对 `tarball` 相对索引文件解析，因此签入仓库的索引与它的打包 tarball 会一起移动；绝对路径按原样保留，而 HTTP 索引会相对自身 URL 解析相对 tarball。[`examples/marketplace/index.json`](../../../examples/marketplace/index.json) 是这种格式的一份可运行文档。

索引在每次目录调用时读取。静态索引是有人编辑的文件或有人拉取的 git 检出，缓存会用那次编辑之前的副本作答；而 seam 本来就惰性解析目录，因此每个用户可见的操作只读取一次。HTTP 读取拒绝重定向，因为重定向会把目录挪到运维人员并未配置的源站，同时它遵守 seam 的取消信号。

失败会抛出 seam 的 `PluginRegistryError`：来源无法读取时为 `PLUGIN_CATALOG_UNREADABLE`，文档、其版本、某个条目的 manifest（元数据清单）字段或某个条目的 release 列表校验失败时为 `PLUGIN_CATALOG_INVALID`。每条消息都会指明解析后的索引路径或 URL。

## 模型体验

无，因为这个目录提供方只读取 JSON 索引，不注册提示词、工具、消息或提供方请求。

#### KV Cache 影响

无；本包从不组装模型输入。

## 已知限制与暂缓事项

- **只读** —— 这里没有发布、签名或写索引的路径；文档由拥有该文件或提供该文件的 git 仓库的人维护。
- **每个组合只有一个索引** —— 提供方 id 固定为 `static`，因此第二次挂载该插件会以 seam 的 `PLUGIN_REGISTRY_DUPLICATE_PROVIDER` 失败；同时提供多个目录需要可配置的 id 或第二个提供方包。
- **整文档读取** —— 每次调用都会取回并校验完整索引，因此规模较大的托管目录在每次搜索时都要付出完整的传输与解析开销。
