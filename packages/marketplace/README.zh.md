# marketplace/ — 插件目录、身份与安装

[English](README.md) | 中文

marketplace 分组在 harness 已有的打包格式之上补充了一个目录。marketplace 插件就是普通的 profile [组合包](../bundle/README.zh.md)——manifest（元数据清单）中声明 `dsh.bundle` 的 npm 包——再加上一个 `dsh.plugin` 段，用于携带展示元数据与发布者声明的能力。本分组不引入第二种打包格式，安装也走 `dsh plugin add` 所用的同一条 profile 路径，因此目录安装与手工输入的安装在 `$DSH_HOME/profiles` 下留下完全相同的 profile。

| 包 | 职责 | ctx key |
|---|---|---|
| [`plugin-manifest/`](plugin-manifest/README.zh.md) | `dsh.plugin` schema 及其校验读取函数 | —（无服务） |
| [`plugin-install/`](plugin-install/README.zh.md) | 解析、安装、卸载并列出 profile 中的插件及其来源记录 | —（无服务） |
| [`plugin-registry/`](plugin-registry/README.zh.md) | 目录 seam 的 Service Definition：搜索、查询、版本、更新 | `pluginRegistry` |
| [`plugin-registry-static/`](plugin-registry-static/README.zh.md) | 从磁盘或 HTTP 读取单个静态索引 JSON 的 Service Provider | —（注册一个提供方） |

安装只接受 tarball。git 依赖会在安装期间运行发布者的 `prepare` 脚本，而包管理器会将其阻断，直到有人为一段自己没读过的构建脚本加入允许列表；打包好的 tarball 已经包含构建产物，因此安装只复制字节、不运行任何脚本。[`examples/marketplace`](../../examples/marketplace/README.zh.md) 是一个可直接运行的索引，其中带有一个可安装的样例插件。

声明的能力是发布者的声明，不是沙箱。已安装插件以 profile patch 层的身份挂载，拥有与内置插件相同的权限，因此每个展示能力的表层都会同时展示 [`plugin-manifest`](plugin-manifest/README.zh.md) 中的 `DECLARED_CAPABILITIES_NOTICE`。[marketplace Agent Note](../../.agents/notes/implemented/feature/2026-08-26-plugin-marketplace-catalog-and-install.zh.md) 记录了该设计及其否决的替代方案。
