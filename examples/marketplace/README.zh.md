# Marketplace 示例

[English](README.md) | 中文

由两个文件构成的完整静态插件 marketplace：[`index.json`](index.json) 是目录，[`hello-plugin/`](hello-plugin) 是它列出的唯一插件。用它可以在没有托管目录的情况下演练 `dsh marketplace`。

目录用 `pnpm pack` 生成的文件名、以相对索引的路径指明其 release 的 tarball。把样例打包到索引旁边，目录即可解析：

```sh
cd examples/marketplace/hello-plugin
pnpm pack --pack-destination ..
```

然后浏览并安装进一个用完即弃的 profile：

```sh
export DSH_HOME=$(mktemp -d)
pnpm dsh marketplace --profile demo --index examples/marketplace/index.json search hello
pnpm dsh marketplace --profile demo --index examples/marketplace/index.json show dsh-plugin-hello-marketplace
pnpm dsh marketplace --profile demo --index examples/marketplace/index.json install dsh-plugin-hello-marketplace
pnpm dsh --profile demo --dump-config
```

dump 结果的末尾是 `# == dsh-plugin-hello-marketplace` 层及其 `hello-marketplace` 配置行，这就是「已安装」的含义：profile 会在下一次启动时多挂载一个 patch 层。正在运行的 `dsh` 不会拾取该层——只有 `cordis.patch.yml` 保持实时生效。

`index.json` 采用[静态目录提供方](../../packages/marketplace/plugin-registry-static/README.zh.md)的文档格式。`hello-plugin/package.json` 展示了 marketplace 插件声明的两半：`dsh.bundle`（profile 启动器挂载的 patch 层）与 `dsh.plugin`（目录元数据与发布者声明的、不被强制执行的能力）。
