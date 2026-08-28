/**
 * Register a static-index catalog provider in `ctx.pluginRegistry`. The index
 * is one JSON document listing every plugin and its releases — a file in a git
 * checkout or an HTTP-served file — which is the whole marketplace backend
 * until a publish pipeline exists.
 * @module @deepseek-ai/dsh-plugin-registry-static
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type {} from '@deepseek-ai/dsh-plugin-registry'
import { StaticPluginCatalogProvider } from './provider.ts'

export {
  STATIC_CATALOG_INDEX_VERSION,
  STATIC_CATALOG_PROVIDER_ID,
  StaticPluginCatalogProvider,
  resolveIndexLocation,
} from './provider.ts'
export type { StaticPluginCatalogProviderOptions } from './provider.ts'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'plugin-registry-static'

/** The catalog seam this provider registers into. */
export const inject = ['pluginRegistry']

/** Plugin config. */
export interface Config {
  /**
   * The index document: an `http(s):` URL, a `file:` URL, or a filesystem
   * path. A relative path resolves against `base`.
   */
  index: string
  /**
   * The directory a relative `index` path resolves against. Defaults to the
   * process working directory, which is what a hand-run command line means by
   * a relative path.
   */
  base?: string
}

export const Config: z<Config> = z.object({
  index: z.string().required(),
  base: z.string(),
})

/** Register the static catalog provider with `ctx.pluginRegistry`. */
export function apply(ctx: Context, config: Config): void {
  ctx.pluginRegistry.registerProvider(new StaticPluginCatalogProvider({
    index: config.index,
    base: config.base ?? process.cwd(),
  }))
}
