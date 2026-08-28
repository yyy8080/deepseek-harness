/**
 * Vocabulary for the marketplace plugin manifest: the `dsh.plugin` package.json
 * section a bundle publishes and the identity every marketplace operation
 * routes on.
 * @module @deepseek-ai/dsh-plugin-manifest/types
 */

import type { Branded } from '@deepseek-ai/dsh-brand'
import { HarnessError } from '@deepseek-ai/dsh-llm'

/**
 * A marketplace plugin's identity: its npm package name. The marketplace
 * invents no second id space — the name a catalog lists, the name the profile
 * installs, and the name `dsh.profile.bundles` carries are the same string, so
 * a listing can never disagree with what the profile mounted.
 */
export type PluginId = Branded<'PluginId'>

/**
 * How much of a capability a publisher declares its plugin uses. `none` claims
 * the plugin never touches the capability; the other levels claim increasing
 * access. Nothing enforces the claim — see {@link PluginCapabilities}.
 */
export type PluginAccessLevel = 'none' | 'read' | 'write'

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
export interface PluginCapabilities {
  /** Tool names the publisher says this plugin contributes to the model. */
  readonly tools: readonly string[]
  /** Declared filesystem access. */
  readonly filesystem: PluginAccessLevel
  /** Declared network access. */
  readonly network: PluginAccessLevel
  /** Whether the publisher says this plugin runs subprocesses. */
  readonly subprocess: boolean
}

/**
 * The `dsh.plugin` section of a bundle's package.json: the marketplace
 * metadata a publisher owns. `dsh.bundle` (the patch layer) stays separate
 * because it is what the profile launcher mounts; this section is what a
 * catalog and a settings surface display.
 */
export interface PluginSection {
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

/** A plugin's `dsh.plugin` section joined to the package name that identifies it. */
export interface PluginManifest extends PluginSection {
  /** The npm package name this section was read from. */
  readonly id: PluginId
}

/**
 * Typed marketplace-manifest failure with a machine-routable `code`. Codes:
 * `PLUGIN_MANIFEST_UNREADABLE` (package.json missing or not parseable),
 * `PLUGIN_MANIFEST_INVALID` (a `dsh.plugin` section that fails the schema),
 * and `PLUGIN_MANIFEST_UNNAMED` (a manifest declaring `dsh.plugin` without a
 * package `name`).
 */
export class PluginManifestError extends HarnessError {}
