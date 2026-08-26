# 插件 marketplace

[English](marketplace.md) | 中文

插件 marketplace——在 harness 本来就会安装的 [profile 组合包](../../packages/bundle/README.zh.md)格式之上，补充一层目录、一份身份与一处信任展示。它拆分在多个包中：`dsh.plugin` schema（[dsh-plugin-manifest](../../packages/marketplace/plugin-manifest)）、profile 安装路径（[dsh-plugin-install](../../packages/marketplace/plugin-install)）、目录[能力 seam](../../.agents/notes/implemented/feature/2026-08-26-plugin-marketplace-catalog-and-install.zh.md) 的 Service Definition（[dsh-plugin-registry](../../packages/marketplace/plugin-registry)，`ctx.pluginRegistry`），以及它的静态索引 Service Provider（[dsh-plugin-registry-static](../../packages/marketplace/plugin-registry-static)）。`dsh marketplace` 是 Consumer。

marketplace 插件不是一种新的包。它就是 manifest（元数据清单）中同时携带 `dsh.plugin` 段的组合包，因此同一个包既能通过 `dsh plugin add` 手工安装，也能通过 `dsh marketplace install` 从目录安装，两者留下相同的 profile。

来源：[`packages/marketplace/plugin-manifest/src/types.ts`](../../packages/marketplace/plugin-manifest/src/types.ts)

## 插件身份与声明的能力

插件以它的 npm 包名标识，并[加了 brand](core.zh.md#branded-ids) 成为 `PluginId`。marketplace 不发明第二套 id 空间，因此一条目录条目永远不会与 profile 实际挂载的东西不一致。它的元数据就是 `dsh.plugin` 段与该名字的组合。

```ts type-equiv
/** A plugin's `dsh.plugin` section joined to the package name that identifies it. */
interface PluginManifest extends PluginSection {
  /** The npm package name this section was read from. */
  readonly id: PluginId
}
```

所有展示字段都是必填的，因为一行渲染出空白名称或空白发布者的目录条目是任何人都无法判断的条目。

```ts type-equiv
/**
 * The `dsh.plugin` section of a bundle's package.json: the marketplace
 * metadata a publisher owns. `dsh.bundle` (the patch layer) stays separate
 * because it is what the profile launcher mounts; this section is what a
 * catalog and a settings surface display.
 */
interface PluginSection {
  /** Human-readable name shown in a catalog listing. */
  readonly displayName: string
  /** One-paragraph description of what the plugin adds. */
  readonly description: string
  /** Who publishes it, as free text a person can recognize. */
  readonly publisher: string
  /** The publisher's declared, unenforced capability claims. */
  readonly capabilities: PluginCapabilities
  /** Project or documentation URL, when the publisher offers one. */
  readonly homepage?: string
}
```

`capabilities` 是这个子系统在诚实性上的难点：它看起来像一组权限，但并不是。

```ts type-equiv
/**
 * A publisher's declaration of what its plugin does with the host.
 *
 * These fields are DECLARATIVE ONLY. A plugin mounts as an ordinary Cordis
 * entry with the same authority as every in-box plugin, so a declaration of
 * `filesystem: 'none'` neither prevents nor detects filesystem access. They
 * exist so a person can read a publisher's claim before installing, and so a
 * later release can compare a claim against enforcement. Treat a claim exactly
 * as you would treat the plugin's README.
 */
interface PluginCapabilities {
  /** Tool names the publisher says this plugin contributes to the model. */
  readonly tools: readonly string[]
  /** Declared filesystem access. */
  readonly filesystem: PluginAccessLevel
  /** Declared network access. */
  readonly network: PluginAccessLevel
  /** Whether the publisher says this plugin runs subprocesses. */
  readonly subprocess: boolean
}
```

`DECLARED_CAPABILITIES_NOTICE` 是一个导出的字符串，因此命令行与设置面板不可能对同一字段做出不同承诺：*Declared by the publisher and not enforced: an installed plugin runs with full harness authority regardless of what it declares.*

## 目录

提供方提供自己的完整目录，不做任何匹配。`ctx.pluginRegistry` 把每个已注册提供方的条目合并成一个以 id 为键的索引，拒绝两个提供方都列出的插件 id，并持有搜索、版本选择与更新检测——因此一次查询的答案永远不取决于哪个提供方先注册。

```ts type-equiv
/**
 * One catalog row: a plugin's marketplace metadata plus its published
 * releases, newest first. `releases[0]` is the version an install with no
 * explicit version resolves to.
 */
interface PluginListing {
  /** Marketplace metadata, including the declared (unenforced) capabilities. */
  readonly manifest: PluginManifest
  /** Published releases, newest first; never empty. */
  readonly releases: readonly PluginRelease[]
}
```

release 指明 tarball，绝不指明 git ref。这是安全选择，而不是打包偏好。

```ts type-equiv
/**
 * One downloadable version of a plugin. `tarball` is what the installer hands
 * to the package manager: an absolute filesystem path or an `https:` URL of a
 * packed npm tarball. The marketplace install path is tarball-only, so a
 * release never carries a git ref — a git dependency would run the publisher's
 * `prepare` script on install, which the package manager blocks until the
 * person allowlists a build they have not read.
 */
interface PluginRelease {
  /** The package version this release publishes. */
  readonly version: string
  /** Absolute filesystem path or `https:` URL of the packed tarball. */
  readonly tarball: string
  /** Publication timestamp as an ISO-8601 string, when the catalog records one. */
  readonly publishedAt?: string
}
```

每次读取都在调用时解析目录，因此刚被人编辑过的来源会按它现在的内容作答。

```ts type-equiv
/**
 * A source of marketplace catalog rows. Registered with
 * {@link PluginRegistry.registerProvider}; `id` is a stable string, unique
 * across registered providers.
 *
 * A provider returns its complete catalog and does no matching: search
 * ranking, version selection, and update detection live in the seam so every
 * source answers a query the same way.
 *
 * There is no usability predicate: a registered source is one an operator
 * configured, so a source that cannot be read is a failure naming what broke,
 * not a provider that quietly drops out of the merge.
 */
interface PluginCatalogProvider {
  readonly id: string
  /** Read the provider's complete catalog; honor `signal` for cancellation. */
  catalog(signal?: AbortSignal): Promise<readonly PluginListing[]>
}
```

`updates` 只比较版本字符串是否相等，从不对它们排序，因此本地安装的预发布版本会被报告为与目录最新 release 不同，而不是与之比较先后。

## 安装来源记录

安装会把 `dsh.marketplace.installs` 写进 profile 自己的 package.json，以已安装包名为键。记录属于 profile 而不属于包，因此即使目录之后发生变化，审计仍能区分目录安装与手工提供的文件。

```ts type-equiv
/**
 * What a profile records about one installed plugin. Provenance is the profile's
 * own record, not the package's claim: it says what this profile fetched and
 * when, so a later audit can tell a catalog install from a hand-supplied file
 * even after the catalog changes.
 */
interface PluginProvenance {
  /** Whether a catalog listing or a direct location named the tarball. */
  readonly origin: PluginOrigin
  /** The tarball location the install fetched, as resolved. */
  readonly tarball: string
  /** The catalog release version, when the install came from a catalog. */
  readonly version?: string
  /** ISO-8601 timestamp of the install. */
  readonly installedAt: string
}
```

安装在下一次启动时生效。profile 启动器在启动时读取一次 `dsh.profile.bundles`，并且只让 `cordis.patch.yml` 保持实时生效，因此新安装的层会在 profile 重新启动时挂载——绝不会在正在运行的进程中挂载。

<!-- BEGIN GENERATED cordis-surface (gen-cordis-catalog.ts) — do not edit between markers -->

<a id="cordis-surface"></a>

## Cordis API

Generated from source by `scripts/gen-cordis-catalog.ts` (verified fresh by `pnpm run verify-cordis-catalog` in doc-sync; regenerate with `pnpm run gen-cordis-catalog`) — the language sides differ only in locale-specific paired document paths. Signature blocks use a `ts cordis-catalog` fence and keep the original source JSDoc; dispatch modes are defined in the [primer](../cordis-primer.zh.md#dispatch-modes), and the framework-inherited `ctx` API lives in [cordis-api/inherited.md](../cordis-api/inherited.md).

<a id="ctxpluginregistry--pluginregistry"></a>

### `ctx.pluginRegistry` — `PluginRegistry`

The marketplace catalog service. Registered as `ctx.pluginRegistry` (one instance per context).

Every read resolves the catalog at call time: providers own their own caching, so the seam holds no second copy that could disagree with a source a person just edited.

```ts cordis-catalog
/**
 * Register a catalog provider. Returns a disposer; disposed with the calling
 * fiber.
 * @param provider - the provider; its `id` is the registry key.
 * @returns the disposer that unregisters the provider.
 * @throws PluginRegistryError `PLUGIN_REGISTRY_DUPLICATE_PROVIDER` when the id is taken.
 */
registerProvider(provider: PluginCatalogProvider): () => void

/**
 * Read every registered provider's catalog and merge it into one id-keyed index.
 * @param signal - optional cancellation signal forwarded to every provider.
 * @returns the merged catalog, keyed by plugin id.
 * @throws PluginRegistryError `PLUGIN_REGISTRY_UNAVAILABLE` when no provider
 * is registered, `PLUGIN_REGISTRY_DUPLICATE_LISTING` when two providers list
 * one plugin, or `PLUGIN_REGISTRY_EMPTY_RELEASES` for a listing with no release.
 */
async catalog(signal?: AbortSignal): Promise<ReadonlyMap<PluginId, PluginListing>>

/**
 * Find listings matching a query, ordered by package name so the same query
 * returns the same order across runs.
 * @param query - the substring and result bound; both optional.
 * @param signal - optional cancellation signal forwarded to every provider.
 * @returns the matching listings, capped to `query.limit`.
 */
async search(query: PluginSearchQuery = {}, signal?: AbortSignal): Promise<readonly PluginListing[]>

/**
 * Look one plugin up by package name.
 * @param id - the plugin's package name.
 * @param signal - optional cancellation signal forwarded to every provider.
 * @returns the listing, or `undefined` when no catalog lists it.
 */
async get(id: PluginId, signal?: AbortSignal): Promise<PluginListing | undefined>

/**
 * List one plugin's published releases, newest first.
 * @param id - the plugin's package name.
 * @param signal - optional cancellation signal forwarded to every provider.
 * @returns the releases, newest first.
 * @throws PluginRegistryError `PLUGIN_REGISTRY_UNKNOWN_PLUGIN` when no catalog lists the id.
 */
async versions(id: PluginId, signal?: AbortSignal): Promise<readonly PluginRelease[]>

/**
 * Report which installed plugins the catalog publishes a different newest
 * release for. An installed plugin no catalog lists is skipped: it may have
 * been installed from a tarball by hand, which is not an error.
 * @param installed - the profile's installed plugins and their versions.
 * @param signal - optional cancellation signal forwarded to every provider.
 * @returns one entry per installed plugin whose version is not the newest release.
 */
async updates( installed: readonly InstalledPluginVersion[], signal?: AbortSignal, ): Promise<readonly PluginUpdate[]>
```

Source: [`packages/marketplace/plugin-registry/src/index.ts`](../../packages/marketplace/plugin-registry/src/index.ts)
<!-- END GENERATED cordis-surface -->
