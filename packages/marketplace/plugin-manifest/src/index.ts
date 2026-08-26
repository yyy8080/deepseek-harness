/**
 * The marketplace plugin manifest: a schemastery schema for the `dsh.plugin`
 * package.json section, plus the readers that turn a package directory or a
 * catalog entry into a validated {@link PluginManifest}.
 *
 * package.json is a durable file written by a publisher, so every field is
 * validated before any consumer reads it and an invalid section fails loud
 * with the file that carries it. A package that declares no `dsh.plugin`
 * section is not a marketplace plugin: {@link readPluginManifest} reports its
 * absence instead of inventing metadata.
 * @module @deepseek-ai/dsh-plugin-manifest
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import z from '@deepseek-ai/schemastery'
import {
  PluginManifestError,
  type PluginAccessLevel,
  type PluginCapabilities,
  type PluginId,
  type PluginManifest,
  type PluginSection,
} from './types.ts'

export { PluginManifestError } from './types.ts'
export type {
  PluginAccessLevel,
  PluginCapabilities,
  PluginId,
  PluginManifest,
  PluginSection,
} from './types.ts'

/**
 * Brand a package name as a plugin identity at the boundary that owns the
 * name: a catalog reader, a manifest reader, or a command line.
 * @param value - the npm package name.
 * @returns the same string, typed as a {@link PluginId}.
 */
export function pluginId(value: string): PluginId {
  return value as PluginId
}

/** Declared access levels, in increasing order of what the publisher claims. */
const ACCESS_LEVELS: readonly PluginAccessLevel[] = ['none', 'read', 'write']

/** Schema for a publisher's unenforced capability claims. */
export const PluginCapabilitiesSchema: z<PluginCapabilities> = z.object({
  tools: z.array(z.string()).required(),
  filesystem: z.union(ACCESS_LEVELS.map(level => z.const(level))).required(),
  network: z.union(ACCESS_LEVELS.map(level => z.const(level))).required(),
  subprocess: z.boolean().required(),
}) as z<PluginCapabilities>

/**
 * Schema for the `dsh.plugin` package.json section. Every display field is
 * required: a catalog row with an absent name or publisher would render as a
 * blank a person cannot judge.
 */
export const PluginSectionSchema: z<PluginSection> = z.object({
  displayName: z.string().required(),
  description: z.string().required(),
  publisher: z.string().required(),
  capabilities: PluginCapabilitiesSchema.required(),
  homepage: z.string(),
}) as z<PluginSection>

/**
 * Validate one `dsh.plugin` section against {@link PluginSectionSchema}.
 * @param value - the raw parsed section.
 * @param source - what to name in the failure message (a file path or catalog URL).
 * @returns the validated section.
 * @throws PluginManifestError `PLUGIN_MANIFEST_INVALID` when the section fails the schema.
 */
export function parsePluginSection(value: unknown, source: string): PluginSection {
  try {
    // The schema is the validation; the cast only satisfies its typed callable.
    return PluginSectionSchema(value as PluginSection)
  } catch (error) {
    throw new PluginManifestError(
      `${source}: invalid dsh.plugin section: ${error instanceof Error ? error.message : String(error)}`,
      'PLUGIN_MANIFEST_INVALID',
      { cause: error },
    )
  }
}

/**
 * Validate one plugin manifest supplied as a whole record — the form a
 * marketplace index embeds, where the package name travels beside the section
 * instead of being read from a package.json.
 * @param value - the raw parsed record, carrying `id` plus the section fields.
 * @param source - what to name in the failure message.
 * @returns the validated manifest.
 * @throws PluginManifestError `PLUGIN_MANIFEST_UNNAMED` when `id` is absent or
 * blank, or `PLUGIN_MANIFEST_INVALID` when the remaining fields fail the schema.
 */
export function parsePluginManifest(value: unknown, source: string): PluginManifest {
  const record = value as { id?: unknown } | null
  const id = typeof record === 'object' && record !== null ? record.id : undefined
  if (typeof id !== 'string' || id === '') {
    throw new PluginManifestError(`${source}: plugin manifest declares no package name in "id"`, 'PLUGIN_MANIFEST_UNNAMED')
  }
  return { ...parsePluginSection(value, source), id: pluginId(id) }
}

/** The package.json fields this package reads. */
interface PackageManifest {
  name?: unknown
  dsh?: { plugin?: unknown } | null
}

/**
 * Read and validate a package's `dsh.plugin` section from its directory.
 * @param packageDir - the package root holding package.json.
 * @returns the validated manifest, or `undefined` when the package declares no
 * `dsh.plugin` section (an ordinary dependency, not a marketplace plugin).
 * @throws PluginManifestError `PLUGIN_MANIFEST_UNREADABLE` when package.json
 * cannot be read or parsed, `PLUGIN_MANIFEST_UNNAMED` when a package declaring
 * the section has no `name`, or `PLUGIN_MANIFEST_INVALID` when the section
 * fails the schema.
 */
export function readPluginManifest(packageDir: string): PluginManifest | undefined {
  const path = join(packageDir, 'package.json')
  let parsed: PackageManifest
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8')) as PackageManifest
  } catch (error) {
    throw new PluginManifestError(
      `${path}: cannot read package manifest: ${error instanceof Error ? error.message : String(error)}`,
      'PLUGIN_MANIFEST_UNREADABLE',
      { cause: error },
    )
  }
  const section = parsed.dsh?.plugin
  if (section === undefined) return undefined
  if (typeof parsed.name !== 'string' || parsed.name === '') {
    throw new PluginManifestError(`${path}: declares dsh.plugin but no package name`, 'PLUGIN_MANIFEST_UNNAMED')
  }
  return { ...parsePluginSection(section, path), id: pluginId(parsed.name) }
}
