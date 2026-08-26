/**
 * A {@link PluginCatalogProvider} over one static marketplace index document:
 * a JSON file reachable through the filesystem or over HTTP.
 *
 * The index is read on every catalog call. A static index is a file someone
 * edits or a git checkout someone pulls, and a cache would answer with the
 * copy from before that edit; the seam already resolves catalogs lazily, so
 * the read happens once per user-visible operation.
 * @module @deepseek-ai/dsh-plugin-registry-static/provider
 */

import { readFileSync } from 'node:fs'
import { dirname, isAbsolute, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import z from '@deepseek-ai/schemastery'
import { parsePluginManifest } from '@deepseek-ai/dsh-plugin-manifest'
import {
  PluginRegistryError,
  type PluginCatalogProvider,
  type PluginListing,
  type PluginRelease,
} from '@deepseek-ai/dsh-plugin-registry'

/** The provider id this package registers under. */
export const STATIC_CATALOG_PROVIDER_ID = 'static'

/** The only index-document version this provider reads. */
export const STATIC_CATALOG_INDEX_VERSION = 1

/** One release row of the index document, before tarball locations are resolved. */
interface IndexRelease {
  version: string
  tarball: string
  publishedAt?: string
}

/** Schema for one release row. */
const IndexReleaseSchema: z<IndexRelease> = z.object({
  version: z.string().required(),
  tarball: z.string().required(),
  publishedAt: z.string(),
})

/** Schema for the release list of one index entry; the manifest fields are validated separately. */
const IndexEntryReleasesSchema: z<{ releases: IndexRelease[] }> = z.object({
  releases: z.array(IndexReleaseSchema).required(),
})

/** Schema for the index document's own frame. */
const IndexFrameSchema: z<{ version: number; plugins: unknown[] }> = z.object({
  version: z.number().required(),
  plugins: z.array(z.any()).required(),
}) as z<{ version: number; plugins: unknown[] }>

/** Where a static index lives and how a relative tarball path resolves against it. */
interface IndexLocation {
  /** What to name in diagnostics. */
  readonly label: string
  /** Read the document text. */
  read(signal?: AbortSignal): Promise<string>
  /** Resolve one release's `tarball` value against this index. */
  resolveTarball(tarball: string): string
}

/** Whether a source string names an HTTP(S) index rather than a filesystem path. */
function isHttpSource(source: string): boolean {
  return /^https?:\/\//.test(source)
}

/** The reason to quote from a caught failure. */
function reasonOf(error: unknown): string {
  /* v8 ignore next -- JSON.parse, schemastery, fetch, and readFileSync all fail by throwing an Error */
  return error instanceof Error ? error.message : String(error)
}

/**
 * Resolve a configured index source into its location.
 * @param source - an `http(s):` URL, a `file:` URL, or a filesystem path.
 * @param base - the directory a relative filesystem path resolves against.
 * @returns the resolved location.
 */
export function resolveIndexLocation(source: string, base: string): IndexLocation {
  if (isHttpSource(source)) {
    const url = new URL(source)
    return {
      label: source,
      read: async (signal?: AbortSignal) => {
        // A redirect would move the catalog to an origin the operator did not
        // configure, so the index must answer at the configured URL.
        const response = await fetch(url, { redirect: 'error', ...signal === undefined ? {} : { signal } })
        if (!response.ok) {
          throw new PluginRegistryError(
            `${source}: marketplace index request failed with HTTP ${response.status}`,
            'PLUGIN_CATALOG_UNREADABLE',
          )
        }
        return response.text()
      },
      resolveTarball: tarball => isHttpSource(tarball) ? tarball : new URL(tarball, url).href,
    }
  }
  const path = source.startsWith('file:') ? fileURLToPath(source) : resolve(base, source)
  const dir = dirname(path)
  return {
    label: path,
    read: () => Promise.resolve(readFileSync(path, 'utf8')),
    // An absolute path stays as written; a relative one is relative to the
    // index file, so a checked-in index and its tarballs move together.
    resolveTarball: tarball => isHttpSource(tarball) || isAbsolute(tarball)
      ? tarball
      : resolve(dir, tarball),
  }
}

/** Validate the release list of one index entry and resolve each tarball location. */
function parseReleases(entry: unknown, id: string, location: IndexLocation): PluginRelease[] {
  let releases: IndexRelease[]
  try {
    // The schema is the validation; the cast only satisfies its typed callable.
    releases = IndexEntryReleasesSchema(entry as { releases: IndexRelease[] }).releases
  } catch (error) {
    throw new PluginRegistryError(
      `${location.label}: plugin "${id}" has an invalid releases list: ${reasonOf(error)}`,
      'PLUGIN_CATALOG_INVALID',
      { cause: error },
    )
  }
  return releases.map(release => ({
    version: release.version,
    tarball: location.resolveTarball(release.tarball),
    ...release.publishedAt === undefined ? {} : { publishedAt: release.publishedAt },
  }))
}

/** Parse one complete index document into catalog listings. */
function parseIndex(text: string, location: IndexLocation): PluginListing[] {
  let frame: { version: number; plugins: unknown[] }
  try {
    frame = IndexFrameSchema(JSON.parse(text))
  } catch (error) {
    throw new PluginRegistryError(
      `${location.label}: not a valid marketplace index document: ${reasonOf(error)}`,
      'PLUGIN_CATALOG_INVALID',
      { cause: error },
    )
  }
  if (frame.version !== STATIC_CATALOG_INDEX_VERSION) {
    throw new PluginRegistryError(
      `${location.label}: marketplace index version ${frame.version} is not supported (expected ${STATIC_CATALOG_INDEX_VERSION})`,
      'PLUGIN_CATALOG_INVALID',
    )
  }
  return frame.plugins.map((entry) => {
    const manifest = parsePluginManifest(entry, location.label)
    return { manifest, releases: parseReleases(entry, manifest.id, location) }
  })
}

/** Construction inputs for {@link StaticPluginCatalogProvider}. */
export interface StaticPluginCatalogProviderOptions {
  /** The index source: an `http(s):` URL, a `file:` URL, or a filesystem path. */
  readonly index: string
  /** The directory a relative filesystem index path resolves against. */
  readonly base: string
}

/** Reads its catalog from one static index document per call. */
export class StaticPluginCatalogProvider implements PluginCatalogProvider {
  readonly id = STATIC_CATALOG_PROVIDER_ID

  private readonly location: IndexLocation

  constructor(options: StaticPluginCatalogProviderOptions) {
    this.location = resolveIndexLocation(options.index, options.base)
  }

  /**
   * Read and validate the configured index.
   * @param signal - optional cancellation signal, honored for an HTTP index.
   * @returns every listing the index publishes, in document order.
   * @throws PluginRegistryError `PLUGIN_CATALOG_UNREADABLE` when the source
   * cannot be read, or `PLUGIN_CATALOG_INVALID` when the document or one of
   * its entries fails validation.
   */
  async catalog(signal?: AbortSignal): Promise<readonly PluginListing[]> {
    let text: string
    try {
      text = await this.location.read(signal)
    } catch (error) {
      if (error instanceof PluginRegistryError) throw error
      throw new PluginRegistryError(
        `${this.location.label}: cannot read the marketplace index: ${reasonOf(error)}`,
        'PLUGIN_CATALOG_UNREADABLE',
        { cause: error },
      )
    }
    return parseIndex(text, this.location)
  }
}
