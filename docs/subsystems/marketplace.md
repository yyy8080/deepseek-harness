# Plugin marketplace

English | [中文](marketplace.zh.md)

The plugin marketplace — a catalog, an identity, and a trust display over the [profile bundle](../../packages/bundle/README.md) format the harness already installs. It is split across packages: the `dsh.plugin` schema ([dsh-plugin-manifest](../../packages/marketplace/plugin-manifest)), the profile install path ([dsh-plugin-install](../../packages/marketplace/plugin-install)), the catalog [capability seam](../../.agents/notes/implemented/feature/2026-08-26-plugin-marketplace-catalog-and-install.md)'s Service Definition ([dsh-plugin-registry](../../packages/marketplace/plugin-registry), `ctx.pluginRegistry`), and its static-index Service Provider ([dsh-plugin-registry-static](../../packages/marketplace/plugin-registry-static)). `dsh marketplace` is the Consumer.

A marketplace plugin is not a new kind of package. It is a bundle whose manifest also carries a `dsh.plugin` section, so the same package installs by hand through `dsh plugin add` and from a catalog through `dsh marketplace install`, and both leave the same profile.

Source: [`packages/marketplace/plugin-manifest/src/types.ts`](../../packages/marketplace/plugin-manifest/src/types.ts)

## Plugin identity and declared capabilities

A plugin is identified by its npm package name, [branded](core.md#branded-ids) as `PluginId`. The marketplace invents no second id space, so a listing can never disagree with what a profile mounted. Its metadata is the `dsh.plugin` section joined to that name.

```ts type-equiv
/** A plugin's `dsh.plugin` section joined to the package name that identifies it. */
interface PluginManifest extends PluginSection {
  /** The npm package name this section was read from. */
  readonly id: PluginId
}
```

Every display field is required, because a catalog row rendering a blank name or publisher is a row nobody can judge.

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

`capabilities` is the honesty problem of this subsystem: it reads like a permission set and is not one.

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

`DECLARED_CAPABILITIES_NOTICE` is one exported string, so a command line and a settings panel cannot promise different things about the same field: *Declared by the publisher and not enforced: an installed plugin runs with full harness authority regardless of what it declares.*

## The catalog

A provider supplies its complete catalog and does no matching. `ctx.pluginRegistry` merges every registered provider's rows into one id-keyed index, rejects a plugin id two providers both list, and owns search, version selection, and update detection — so the answer to a query never depends on which provider registered first.

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

A release names a tarball and never a git ref. That is a security choice rather than a packaging preference.

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

Every read resolves the catalog at call time, so a source someone just edited answers with what it now says.

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

`updates` compares version strings for equality and never orders them, so a locally installed pre-release is reported as differing from the catalog's newest release rather than being ranked against it.

## Install provenance

Installing writes `dsh.marketplace.installs` into the profile's own package.json, keyed by installed package name. The record belongs to the profile rather than to the package, so an audit can still distinguish a catalog install from a hand-supplied file after the catalog has changed.

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

An install takes effect at the next launch. The profile launcher reads `dsh.profile.bundles` once at boot and keeps only `cordis.patch.yml` live, so a newly installed layer mounts when the profile relaunches — never in the running process.

<!-- BEGIN GENERATED cordis-surface (gen-cordis-catalog.ts) — do not edit between markers -->

<a id="cordis-surface"></a>

## Cordis API

Generated from source by `scripts/gen-cordis-catalog.ts` (verified fresh by `pnpm run verify-cordis-catalog` in doc-sync; regenerate with `pnpm run gen-cordis-catalog`) — the language sides differ only in locale-specific paired document paths. Signature blocks use a `ts cordis-catalog` fence and keep the original source JSDoc; dispatch modes are defined in the [primer](../cordis-primer.md#dispatch-modes), and the framework-inherited `ctx` API lives in [cordis-api/inherited.md](../cordis-api/inherited.md).

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
