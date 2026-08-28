/**
 * Vocabulary for the plugin-registry capability seam (`ctx.pluginRegistry`):
 * what a catalog provider supplies and what a marketplace consumer reads.
 * @module @deepseek-ai/dsh-plugin-registry/types
 */

import { HarnessError } from '@deepseek-ai/dsh-llm'
import type { PluginId, PluginManifest } from '@deepseek-ai/dsh-plugin-manifest'

/**
 * One downloadable version of a plugin. `tarball` is what the installer hands
 * to the package manager: an absolute filesystem path or an `https:` URL of a
 * packed npm tarball. The marketplace install path is tarball-only, so a
 * release never carries a git ref — a git dependency would run the publisher's
 * `prepare` script on install, which the package manager blocks until the
 * person allowlists a build they have not read.
 */
export interface PluginRelease {
  /** The package version this release publishes. */
  readonly version: string
  /** Absolute filesystem path or `https:` URL of the packed tarball. */
  readonly tarball: string
  /** Publication timestamp as an ISO-8601 string, when the catalog records one. */
  readonly publishedAt?: string
}

/**
 * One catalog row: a plugin's marketplace metadata plus its published
 * releases, newest first. `releases[0]` is the version an install with no
 * explicit version resolves to.
 */
export interface PluginListing {
  /** Marketplace metadata, including the declared (unenforced) capabilities. */
  readonly manifest: PluginManifest
  /** Published releases, newest first; never empty. */
  readonly releases: readonly PluginRelease[]
}

/** What a marketplace search asks for. */
export interface PluginSearchQuery {
  /**
   * Case-insensitive substring matched against the package name, display name,
   * description, and publisher. Omitted or empty matches every listing.
   */
  readonly text?: string
  /** Upper bound on returned listings; the seam truncates to it. Omitted = no bound. */
  readonly limit?: number
}

/** One installed plugin's identity and version, as supplied to {@link PluginRegistry.updates}. */
export interface InstalledPluginVersion {
  readonly id: PluginId
  readonly version: string
}

/**
 * A catalog release that differs from what is installed. Reported whenever the
 * installed version is not the catalog's newest release: the seam compares
 * version strings for equality and never orders them, so a locally installed
 * pre-release also appears here.
 */
export interface PluginUpdate {
  readonly id: PluginId
  /** The version currently installed in the profile. */
  readonly installed: string
  /** The catalog's newest release for this plugin. */
  readonly latest: PluginRelease
}

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
export interface PluginCatalogProvider {
  readonly id: string
  /** Read the provider's complete catalog; honor `signal` for cancellation. */
  catalog(signal?: AbortSignal): Promise<readonly PluginListing[]>
}

/**
 * Typed registry error with a machine-routable `code`. Codes:
 * `PLUGIN_REGISTRY_DUPLICATE_PROVIDER` (two providers claim one id),
 * `PLUGIN_REGISTRY_UNAVAILABLE` (no provider is registered),
 * `PLUGIN_REGISTRY_DUPLICATE_LISTING` (two providers list one plugin id),
 * `PLUGIN_REGISTRY_EMPTY_RELEASES` (a provider returned a listing with no
 * release), and `PLUGIN_REGISTRY_UNKNOWN_PLUGIN` (no catalog lists the
 * requested id). A provider adds its own codes for source failures.
 */
export class PluginRegistryError extends HarnessError {}
