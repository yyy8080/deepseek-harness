/**
 * Service Definition for the plugin-registry capability seam
 * (`ctx.pluginRegistry`): a provider registry over marketplace catalog sources
 * plus the search, lookup, and update-detection every consumer shares.
 *
 * Providers supply complete catalogs and no matching. The seam aggregates the
 * catalogs of every usable provider, rejecting a plugin id two providers both
 * list, so the answer to a query never depends on registration order. Nothing
 * here installs: a listing names a tarball, and
 * `@deepseek-ai/dsh-plugin-install` is what puts it in a profile.
 * @module @deepseek-ai/dsh-plugin-registry
 */

import { Context, Service } from '@deepseek-ai/cordis'
import type { PluginId } from '@deepseek-ai/dsh-plugin-manifest'
import {
  PluginRegistryError,
  type InstalledPluginVersion,
  type PluginCatalogProvider,
  type PluginListing,
  type PluginRelease,
  type PluginSearchQuery,
  type PluginUpdate,
} from './types.ts'

export { PluginRegistryError } from './types.ts'
export type {
  InstalledPluginVersion,
  PluginCatalogProvider,
  PluginListing,
  PluginRelease,
  PluginSearchQuery,
  PluginUpdate,
} from './types.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    pluginRegistry: PluginRegistry
  }
}

/**
 * Whether a listing matches a case-insensitive substring across the fields a
 * person would type: the package name, display name, description, and
 * publisher.
 */
function matches(listing: PluginListing, needle: string): boolean {
  const { manifest } = listing
  return [manifest.id, manifest.displayName, manifest.description, manifest.publisher]
    .some(field => field.toLowerCase().includes(needle))
}

/**
 * The marketplace catalog service. Registered as `ctx.pluginRegistry` (one
 * instance per context).
 *
 * Every read resolves the catalog at call time: providers own their own
 * caching, so the seam holds no second copy that could disagree with a source
 * a person just edited.
 */
export class PluginRegistry extends Service {
  private readonly providers = new Map<string, PluginCatalogProvider>()

  constructor(ctx: Context) {
    super(ctx, 'pluginRegistry')
  }

  /**
   * Register a catalog provider. Returns a disposer; disposed with the calling
   * fiber.
   * @param provider - the provider; its `id` is the registry key.
   * @returns the disposer that unregisters the provider.
   * @throws PluginRegistryError `PLUGIN_REGISTRY_DUPLICATE_PROVIDER` when the id is taken.
   */
  registerProvider(provider: PluginCatalogProvider): () => void {
    if (this.providers.has(provider.id)) {
      throw new PluginRegistryError(
        `a plugin catalog provider with id "${provider.id}" is already registered`,
        'PLUGIN_REGISTRY_DUPLICATE_PROVIDER',
      )
    }
    const dispose = this.ctx.effect(function* (this: PluginRegistry) {
      this.providers.set(provider.id, provider)
      yield () => this.providers.delete(provider.id)
    }.bind(this), 'pluginRegistry.registerProvider()')
    // ctx.effect's disposer returns Promise<void>; this API is synchronous
    // fire-and-forget — discard the (always-resolved) promise.
    return () => void dispose()
  }

  /**
   * Read every registered provider's catalog and merge it into one id-keyed index.
   * @param signal - optional cancellation signal forwarded to every provider.
   * @returns the merged catalog, keyed by plugin id.
   * @throws PluginRegistryError `PLUGIN_REGISTRY_UNAVAILABLE` when no provider
   * is registered, `PLUGIN_REGISTRY_DUPLICATE_LISTING` when two providers list
   * one plugin, or `PLUGIN_REGISTRY_EMPTY_RELEASES` for a listing with no release.
   */
  async catalog(signal?: AbortSignal): Promise<ReadonlyMap<PluginId, PluginListing>> {
    const registered = [...this.providers.values()]
    if (registered.length === 0) {
      throw new PluginRegistryError('no plugin catalog provider is registered', 'PLUGIN_REGISTRY_UNAVAILABLE')
    }
    const merged = new Map<PluginId, PluginListing>()
    const owners = new Map<PluginId, string>()
    for (const provider of registered) {
      for (const listing of await provider.catalog(signal)) {
        const id = listing.manifest.id
        const owner = owners.get(id)
        if (owner !== undefined) {
          throw new PluginRegistryError(
            `plugin "${id}" is listed by both catalog providers "${owner}" and "${provider.id}"`,
            'PLUGIN_REGISTRY_DUPLICATE_LISTING',
          )
        }
        if (listing.releases.length === 0) {
          throw new PluginRegistryError(
            `catalog provider "${provider.id}" lists plugin "${id}" with no release`,
            'PLUGIN_REGISTRY_EMPTY_RELEASES',
          )
        }
        owners.set(id, provider.id)
        merged.set(id, listing)
      }
    }
    return merged
  }

  /**
   * Find listings matching a query, ordered by package name so the same query
   * returns the same order across runs.
   * @param query - the substring and result bound; both optional.
   * @param signal - optional cancellation signal forwarded to every provider.
   * @returns the matching listings, capped to `query.limit`.
   */
  async search(query: PluginSearchQuery = {}, signal?: AbortSignal): Promise<readonly PluginListing[]> {
    const needle = (query.text ?? '').toLowerCase()
    const found = [...(await this.catalog(signal)).values()]
      .filter(listing => needle === '' || matches(listing, needle))
      .sort((left, right) => left.manifest.id.localeCompare(right.manifest.id))
    return query.limit === undefined ? found : found.slice(0, query.limit)
  }

  /**
   * Look one plugin up by package name.
   * @param id - the plugin's package name.
   * @param signal - optional cancellation signal forwarded to every provider.
   * @returns the listing, or `undefined` when no catalog lists it.
   */
  async get(id: PluginId, signal?: AbortSignal): Promise<PluginListing | undefined> {
    return (await this.catalog(signal)).get(id)
  }

  /**
   * List one plugin's published releases, newest first.
   * @param id - the plugin's package name.
   * @param signal - optional cancellation signal forwarded to every provider.
   * @returns the releases, newest first.
   * @throws PluginRegistryError `PLUGIN_REGISTRY_UNKNOWN_PLUGIN` when no catalog lists the id.
   */
  async versions(id: PluginId, signal?: AbortSignal): Promise<readonly PluginRelease[]> {
    const listing = await this.get(id, signal)
    if (listing === undefined) {
      throw new PluginRegistryError(`no catalog lists plugin "${id}"`, 'PLUGIN_REGISTRY_UNKNOWN_PLUGIN')
    }
    return listing.releases
  }

  /**
   * Report which installed plugins the catalog publishes a different newest
   * release for. An installed plugin no catalog lists is skipped: it may have
   * been installed from a tarball by hand, which is not an error.
   * @param installed - the profile's installed plugins and their versions.
   * @param signal - optional cancellation signal forwarded to every provider.
   * @returns one entry per installed plugin whose version is not the newest release.
   */
  async updates(
    installed: readonly InstalledPluginVersion[], signal?: AbortSignal,
  ): Promise<readonly PluginUpdate[]> {
    const catalog = await this.catalog(signal)
    const updates: PluginUpdate[] = []
    for (const entry of installed) {
      const listing = catalog.get(entry.id)
      // `catalog()` rejects an empty release list, so index 0 always exists.
      const latest = listing?.releases[0]
      if (latest === undefined || latest.version === entry.version) continue
      updates.push({ id: entry.id, installed: entry.version, latest })
    }
    return updates
  }
}

export default PluginRegistry
