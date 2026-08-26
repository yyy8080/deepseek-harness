/**
 * `dsh marketplace <verb>` — browse a plugin catalog and install from it into
 * a profile.
 *
 * The catalog is read through a real composition: this module mounts
 * `@deepseek-ai/dsh-plugin-registry` and the static-index provider in a bare
 * Cordis context, so the command line sees exactly the seam a settings surface
 * sees. Installing goes through `@deepseek-ai/dsh-plugin-install`, the same
 * path `dsh plugin add` takes, so a marketplace install and a hand-typed one
 * leave identical profiles.
 * @module @deepseek-ai/dsh/marketplace
 */

import { Context } from '@deepseek-ai/cordis'
import {
  DECLARED_CAPABILITIES_NOTICE,
  pluginId,
  type PluginCapabilities,
  type PluginId,
} from '@deepseek-ai/dsh-plugin-manifest'
import PluginRegistry, {
  type PluginListing,
  type PluginRelease,
} from '@deepseek-ai/dsh-plugin-registry'
import * as staticCatalog from '@deepseek-ai/dsh-plugin-registry-static'
import { install, list, resolve as resolveInstall, uninstall } from '@deepseek-ai/dsh-plugin-install'
import { INSTALL_ANCHOR } from './profile-boot.ts'

const NAME = 'dsh'

/** Environment variable naming the catalog index when `--index` is omitted. */
export const MARKETPLACE_INDEX_ENV = 'DSH_MARKETPLACE_INDEX'

/** The verbs `dsh marketplace` accepts. */
export type MarketplaceVerb = 'search' | 'show' | 'install' | 'uninstall' | 'list' | 'updates'

/** One resolved `dsh marketplace` invocation. */
export interface MarketplaceInvocation {
  /** Which operation to run. */
  readonly verb: MarketplaceVerb
  /** The profile the operation reads or writes. */
  readonly profile: string
  /** The catalog index source; `undefined` falls back to `$DSH_MARKETPLACE_INDEX`. */
  readonly index?: string
  /** The search text, or the `<package>[@version]` argument, depending on the verb. */
  readonly target?: string
  /** Upper bound on search results. */
  readonly limit?: number
}

/** Print one line to standard output. */
function say(line: string): void {
  process.stdout.write(`${line}\n`)
}

/** Resolve the catalog index source, failing loud when neither flag nor environment names one. */
function resolveIndex(invocation: MarketplaceInvocation): string {
  const index = invocation.index ?? process.env[MARKETPLACE_INDEX_ENV]
  if (index === undefined || index === '') {
    throw new Error(
      `${NAME}: no marketplace catalog configured — pass --index <path-or-url> or set ${MARKETPLACE_INDEX_ENV}`,
    )
  }
  return index
}

/**
 * Mount the registry seam and its static provider, run one read, and dispose.
 * @param index - the catalog index source.
 * @param read - what to ask the mounted seam.
 * @returns whatever `read` resolved to.
 */
async function withRegistry<T>(index: string, read: (registry: PluginRegistry) => Promise<T>): Promise<T> {
  const ctx = new Context()
  await ctx.plugin(PluginRegistry)
  await ctx.plugin(staticCatalog, { index, base: process.cwd() })
  try {
    return await read(ctx.pluginRegistry)
  } finally {
    await ctx.fiber.dispose()
  }
}

/** Split a `<package>[@version]` argument; a scoped name's leading `@` is not a separator. */
function splitVersioned(argument: string): { id: PluginId; version?: string } {
  const at = argument.lastIndexOf('@')
  if (at <= 0) return { id: pluginId(argument) }
  return { id: pluginId(argument.slice(0, at)), version: argument.slice(at + 1) }
}

/** Render declared capabilities as one line a person can scan. */
function renderCapabilities(capabilities: PluginCapabilities): string {
  const tools = capabilities.tools.length === 0 ? 'none' : capabilities.tools.join(', ')
  return `tools: ${tools}; filesystem: ${capabilities.filesystem}; network: ${capabilities.network}; `
    + `subprocess: ${capabilities.subprocess ? 'yes' : 'no'}`
}

/** Print one catalog row in the compact search form. */
function printListing(listing: PluginListing): void {
  const latest = listing.releases[0]
  say(`${listing.manifest.id}@${latest?.version ?? 'unknown'}  ${listing.manifest.displayName}`)
  say(`  ${listing.manifest.description}`)
  say(`  publisher: ${listing.manifest.publisher}`)
}

/** Print one catalog row in the full detail form. */
function printDetail(listing: PluginListing): void {
  const { manifest } = listing
  say(manifest.id)
  say(`  name:        ${manifest.displayName}`)
  say(`  publisher:   ${manifest.publisher}`)
  if (manifest.homepage !== undefined) say(`  homepage:    ${manifest.homepage}`)
  say(`  description: ${manifest.description}`)
  say(`  versions:    ${listing.releases.map(release => release.version).join(', ')}`)
  say(`  declared:    ${renderCapabilities(manifest.capabilities)}`)
  say(`  note:        ${DECLARED_CAPABILITIES_NOTICE}`)
}

/** Choose the release an install request names, or the newest when it names none. */
function selectRelease(listing: PluginListing, version: string | undefined): PluginRelease {
  if (version === undefined) {
    const [latest] = listing.releases
    // `catalog()` rejects a listing with no release.
    /* v8 ignore next */
    if (latest === undefined) throw new Error(`${NAME}: ${listing.manifest.id} publishes no release`)
    return latest
  }
  const release = listing.releases.find(candidate => candidate.version === version)
  if (release === undefined) {
    throw new Error(
      `${NAME}: ${listing.manifest.id} publishes no version ${version} `
      + `(available: ${listing.releases.map(candidate => candidate.version).join(', ')})`,
    )
  }
  return release
}

/** Look one plugin up, failing loud when the catalog does not list it. */
async function requireListing(registry: PluginRegistry, id: PluginId): Promise<PluginListing> {
  const listing = await registry.get(id)
  if (listing === undefined) throw new Error(`${NAME}: no catalog lists ${id}`)
  return listing
}

/** Read the `<package>[@version]` argument a verb requires. */
function requireTarget(invocation: MarketplaceInvocation): string {
  const { target } = invocation
  if (target === undefined || target === '') {
    throw new Error(`${NAME}: marketplace ${invocation.verb} needs a package name`)
  }
  return target
}

/** Run `search`. */
async function runSearch(invocation: MarketplaceInvocation): Promise<void> {
  const listings = await withRegistry(resolveIndex(invocation), registry => registry.search({
    ...invocation.target === undefined ? {} : { text: invocation.target },
    ...invocation.limit === undefined ? {} : { limit: invocation.limit },
  }))
  if (listings.length === 0) {
    say('no plugin matches')
    return
  }
  for (const listing of listings) printListing(listing)
}

/** Run `show`. */
async function runShow(invocation: MarketplaceInvocation): Promise<void> {
  const { id } = splitVersioned(requireTarget(invocation))
  printDetail(await withRegistry(resolveIndex(invocation), registry => requireListing(registry, id)))
}

/** Run `install`. */
async function runInstall(invocation: MarketplaceInvocation): Promise<void> {
  const { id, version } = splitVersioned(requireTarget(invocation))
  const release = await withRegistry(resolveIndex(invocation), async (registry) => {
    return selectRelease(await requireListing(registry, id), version)
  })
  const result = install(resolveInstall({
    profile: invocation.profile,
    installAnchor: INSTALL_ANCHOR,
    tarball: release.tarball,
    origin: 'marketplace',
    version: release.version,
  }), { warn: message => process.stderr.write(`${NAME}: ${message}\n`), stdio: 'inherit' })
  say(`installed ${result.id}@${result.version} into profile ${invocation.profile}`)
  if (result.manifest !== undefined) {
    say(`  declared: ${renderCapabilities(result.manifest.capabilities)}`)
    say(`  note:     ${DECLARED_CAPABILITIES_NOTICE}`)
  }
  say(result.bundle
    ? `  the profile now mounts ${result.id} as a patch layer — relaunch dsh --profile ${invocation.profile} to use it`
    : `  ${result.id} declares no dsh.bundle, so it is a plain dependency and mounts nothing`)
}

/** Run `uninstall`. */
function runUninstall(invocation: MarketplaceInvocation): void {
  const { id } = splitVersioned(requireTarget(invocation))
  const result = uninstall(
    { profile: invocation.profile, installAnchor: INSTALL_ANCHOR },
    id,
    { warn: message => process.stderr.write(`${NAME}: ${message}\n`), stdio: 'inherit' },
  )
  say(`removed ${result.id} from profile ${invocation.profile}`)
  if (result.bundle) say(`  relaunch dsh --profile ${invocation.profile} to drop its patch layer`)
}

/** Run `list`. */
function runList(invocation: MarketplaceInvocation): void {
  const installed = list({ profile: invocation.profile, installAnchor: INSTALL_ANCHOR })
  if (installed.length === 0) {
    say(`profile ${invocation.profile} has no installed plugins`)
    return
  }
  for (const plugin of installed) {
    const layer = plugin.bundle ? 'layer' : 'dependency'
    say(`${plugin.id}@${plugin.version}  (${layer})`)
    if (plugin.manifest !== undefined) say(`  ${plugin.manifest.displayName} — ${plugin.manifest.publisher}`)
    if (plugin.provenance !== undefined) {
      say(`  installed ${plugin.provenance.installedAt} from ${plugin.provenance.origin}: ${plugin.provenance.tarball}`)
    }
  }
}

/** Run `updates`. */
async function runUpdates(invocation: MarketplaceInvocation): Promise<void> {
  const installed = list({ profile: invocation.profile, installAnchor: INSTALL_ANCHOR })
    .map(plugin => ({ id: plugin.id, version: plugin.version }))
  const updates = await withRegistry(resolveIndex(invocation), registry => registry.updates(installed))
  if (updates.length === 0) {
    say(`profile ${invocation.profile} matches the catalog`)
    return
  }
  for (const update of updates) say(`${update.id}: installed ${update.installed}, catalog ${update.latest.version}`)
}

/**
 * Run one `dsh marketplace` invocation.
 * @param invocation - the resolved verb and its arguments.
 * @returns the process exit code: 0 on success, 1 with a diagnostic on failure.
 */
export async function runMarketplace(invocation: MarketplaceInvocation): Promise<number> {
  try {
    switch (invocation.verb) {
      case 'search': await runSearch(invocation); break
      case 'show': await runShow(invocation); break
      case 'install': await runInstall(invocation); break
      case 'uninstall': runUninstall(invocation); break
      case 'list': runList(invocation); break
      case 'updates': await runUpdates(invocation); break
      default: invocation.verb satisfies never
    }
    return 0
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
    return 1
  }
}
