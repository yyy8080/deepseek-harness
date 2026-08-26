/**
 * Profile plugin installation: the one path that puts a package in a profile,
 * whether a marketplace surface, a command line, or a raw pnpm forward asks
 * for it.
 *
 * Every operation ends in the same two steps — run pnpm in the profile
 * directory, then reconcile `dsh.profile.bundles` against what is installed —
 * so a marketplace install and a hand-typed `dsh plugin add` produce the same
 * profile. Installing does not change the running tree: the profile launcher
 * reads `dsh.profile.bundles` once, at boot, and keeps only `cordis.patch.yml`
 * live, so a newly installed layer mounts on the next launch.
 * @module @deepseek-ai/dsh-plugin-install
 */

import { existsSync } from 'node:fs'
import { join } from 'node:path'
import {
  DEFAULT_PROFILE_BUNDLES,
  initProfile,
  PROFILE_TEMPLATES,
  readProfileManifest,
  resolveProfileDir,
  writeProfileManifest,
  type ProfileManifest,
} from '@deepseek-ai/dsh-app-boot'
import { pluginId, readPluginManifest, type PluginId } from '@deepseek-ai/dsh-plugin-manifest'
import { anchorPathSpec, runPackageManager } from './package-manager.ts'
import { BIN_NAME, reconcileBundles, resolveInstalledDir, type ReconcileWarn } from './reconcile.ts'
import {
  PluginInstallError,
  type InstalledPlugin,
  type InstallRequest,
  type InstallResult,
  type InstallSpec,
  type PluginProvenance,
  type ProfileTarget,
  type UninstallResult,
} from './types.ts'

export { anchorPathSpec } from './package-manager.ts'
export { PluginInstallError } from './types.ts'
export type {
  DshMarketplaceSection,
  InstalledPlugin,
  InstallRequest,
  InstallResult,
  InstallSpec,
  PluginOrigin,
  PluginProvenance,
  ProfileTarget,
  UninstallResult,
} from './types.ts'

/** Whether a tarball location is fetched over the network rather than from disk. */
function isRemote(location: string): boolean {
  return /^https?:\/\//.test(location)
}

/**
 * Ensure a profile directory is initialized, applying its shipped template on
 * first use.
 * @param profile - the profile name, which selects the template.
 * @param dir - the absolute profile directory.
 * @param announce - sink for the one-line first-use notice; omitted stays silent.
 */
function ensureProfile(profile: string, dir: string, announce?: ReconcileWarn): void {
  if (existsSync(join(dir, 'package.json'))) return
  initProfile(dir, PROFILE_TEMPLATES[profile] ?? DEFAULT_PROFILE_BUNDLES)
  announce?.(`initialized profile ${profile} at ${dir}`)
}

/**
 * Resolve an install request into the specification the executor runs: the
 * profile directory, the exact package-manager argument, and the provenance to
 * record. Defaulting happens here and nowhere else, so a caller can print or
 * confirm what an install will do before it runs.
 * @param request - the profile, the tarball, and the optional catalog facts.
 * @returns the resolved specification.
 */
export function resolve(request: InstallRequest): InstallSpec {
  const packageSpec = isRemote(request.tarball)
    ? request.tarball
    : anchorPathSpec(request.tarball, request.cwd ?? process.cwd())
  const origin = request.origin ?? 'tarball'
  return {
    profile: request.profile,
    profileDir: resolveProfileDir(request.profile, request.home),
    packageSpec,
    installAnchor: request.installAnchor,
    provenance: {
      origin,
      tarball: packageSpec,
      ...request.version === undefined ? {} : { version: request.version },
    },
  }
}

/** Name the one dependency a package-manager run added or re-pointed. */
function installedName(before: ProfileManifest, after: ProfileManifest, packageSpec: string): string {
  const beforeDeps = before.dependencies ?? {}
  const afterDeps = after.dependencies ?? {}
  const added = Object.keys(afterDeps).filter(dependency => !(dependency in beforeDeps))
  const [firstAdded] = added
  if (added.length === 1 && firstAdded !== undefined) return firstAdded
  // Reinstalling an already-present plugin adds no dependency; the same name
  // is simply re-pointed at the new tarball.
  const repointed = Object.keys(afterDeps).filter(
    dependency => dependency in beforeDeps && afterDeps[dependency] !== beforeDeps[dependency],
  )
  const [firstRepointed] = repointed
  if (added.length === 0 && repointed.length === 1 && firstRepointed !== undefined) return firstRepointed
  throw new PluginInstallError(
    `installing ${packageSpec} added no single dependency to the profile (added: ${added.join(', ') || 'none'})`,
    'PLUGIN_INSTALL_NO_PACKAGE',
  )
}

/** Read an installed package's version, or report it as unknown when the package.json omits one. */
function installedVersion(packageDir: string | undefined): string {
  if (packageDir === undefined) return 'unknown'
  const version = (readProfileManifest(BIN_NAME, packageDir) as { version?: unknown }).version
  return typeof version === 'string' ? version : 'unknown'
}

/** Record one install's provenance in the profile manifest. */
function recordProvenance(profileDir: string, name: string, provenance: PluginProvenance): void {
  const manifest = readProfileManifest(BIN_NAME, profileDir)
  const installs = { ...manifest.dsh?.marketplace?.installs, [name]: provenance }
  manifest.dsh = { ...manifest.dsh, marketplace: { ...manifest.dsh?.marketplace, installs } }
  writeProfileManifest(profileDir, manifest)
}

/** Drop one package's provenance record from the profile manifest. */
function forgetProvenance(profileDir: string, name: string): void {
  const manifest = readProfileManifest(BIN_NAME, profileDir)
  const installs = manifest.dsh?.marketplace?.installs
  if (installs === undefined || !(name in installs)) return
  const remaining = Object.fromEntries(Object.entries(installs).filter(([key]) => key !== name))
  manifest.dsh = { ...manifest.dsh, marketplace: { ...manifest.dsh?.marketplace, installs: remaining } }
  writeProfileManifest(profileDir, manifest)
}

/** Options shared by the operations that run the package manager. */
export interface OperationOptions {
  /** Sink for progress and reconciliation notices; omitted stays silent. */
  readonly warn?: ReconcileWarn
  /** `inherit` streams pnpm's output to this process; `pipe` (the default) captures it. */
  readonly stdio?: 'inherit' | 'pipe'
}

/**
 * Install one resolved specification into its profile.
 * @param spec - the resolved specification from {@link resolve}.
 * @param options - output sink and pnpm stream disposition.
 * @returns what was installed, including the recorded provenance.
 * @throws PluginInstallError `PLUGIN_INSTALL_FAILED` when pnpm exits non-zero,
 * or `PLUGIN_INSTALL_NO_PACKAGE` when the run added no identifiable dependency.
 */
export function install(spec: InstallSpec, options: OperationOptions = {}): InstallResult {
  ensureProfile(spec.profile, spec.profileDir, options.warn)
  const before = readProfileManifest(BIN_NAME, spec.profileDir)
  const run = runPackageManager({
    cwd: spec.profileDir,
    args: ['add', spec.packageSpec],
    stdio: options.stdio ?? 'pipe',
  })
  if (run.exitCode !== 0) {
    throw new PluginInstallError(
      `pnpm failed to install ${spec.packageSpec} into ${spec.profileDir} (exit ${run.exitCode})${run.stderr === '' ? '' : `: ${run.stderr.trim()}`}`,
      'PLUGIN_INSTALL_FAILED',
    )
  }
  const after = readProfileManifest(BIN_NAME, spec.profileDir)
  const name = installedName(before, after, spec.packageSpec)
  const added = reconcileBundles(before, spec.profileDir, spec.installAnchor, message => options.warn?.(message))
  const provenance: PluginProvenance = { ...spec.provenance, installedAt: new Date().toISOString() }
  recordProvenance(spec.profileDir, name, provenance)
  const packageDir = resolveInstalledDir(name, spec.profileDir, spec.installAnchor)
  const manifest = packageDir === undefined ? undefined : readPluginManifest(packageDir)
  return {
    id: pluginId(name),
    version: installedVersion(packageDir),
    bundle: added.includes(name),
    ...manifest === undefined ? {} : { manifest },
    provenance,
  }
}

/**
 * Remove one plugin from a profile.
 * @param target - the profile and its bundle-resolution anchor.
 * @param id - the installed package name to remove.
 * @param options - output sink and pnpm stream disposition.
 * @returns the removed package name and whether it had been a layer.
 * @throws PluginInstallError `PLUGIN_INSTALL_NOT_INSTALLED` when the profile
 * does not depend on the package, or `PLUGIN_INSTALL_FAILED` when pnpm exits non-zero.
 */
export function uninstall(target: ProfileTarget, id: PluginId, options: OperationOptions = {}): UninstallResult {
  const profileDir = resolveProfileDir(target.profile, target.home)
  if (!existsSync(join(profileDir, 'package.json'))) {
    throw new PluginInstallError(`profile ${target.profile} has no installed plugins`, 'PLUGIN_INSTALL_NOT_INSTALLED')
  }
  const before = readProfileManifest(BIN_NAME, profileDir)
  if (!(id in (before.dependencies ?? {}))) {
    throw new PluginInstallError(`profile ${target.profile} does not depend on ${id}`, 'PLUGIN_INSTALL_NOT_INSTALLED')
  }
  const bundle = (before.dsh?.profile?.bundles ?? []).includes(id)
  const run = runPackageManager({ cwd: profileDir, args: ['remove', id], stdio: options.stdio ?? 'pipe' })
  if (run.exitCode !== 0) {
    throw new PluginInstallError(
      `pnpm failed to remove ${id} from ${profileDir} (exit ${run.exitCode})${run.stderr === '' ? '' : `: ${run.stderr.trim()}`}`,
      'PLUGIN_INSTALL_FAILED',
    )
  }
  reconcileBundles(before, profileDir, target.installAnchor, message => options.warn?.(message))
  forgetProvenance(profileDir, id)
  return { id, bundle }
}

/**
 * List a profile's out-of-tree plugin dependencies with their provenance. In-box
 * template bundles are not dependencies and do not appear here.
 * @param target - the profile and its bundle-resolution anchor.
 * @returns one entry per dependency, ordered by package name; empty for a profile with no manifest.
 */
export function list(target: ProfileTarget): readonly InstalledPlugin[] {
  const profileDir = resolveProfileDir(target.profile, target.home)
  if (!existsSync(join(profileDir, 'package.json'))) return []
  const manifest = readProfileManifest(BIN_NAME, profileDir)
  const bundles = new Set(manifest.dsh?.profile?.bundles ?? [])
  const installs = manifest.dsh?.marketplace?.installs ?? {}
  return Object.keys(manifest.dependencies ?? {}).sort((left, right) => left.localeCompare(right)).map((name) => {
    const packageDir = resolveInstalledDir(name, profileDir, target.installAnchor)
    const plugin = packageDir === undefined ? undefined : readPluginManifest(packageDir)
    const provenance = installs[name]
    return {
      id: pluginId(name),
      version: installedVersion(packageDir),
      bundle: bundles.has(name),
      ...plugin === undefined ? {} : { manifest: plugin },
      ...provenance === undefined ? {} : { provenance },
    }
  })
}

/**
 * Forward raw pnpm arguments into a profile directory and reconcile afterwards
 * — the escape hatch `dsh plugin <args...>` exposes for operations the
 * marketplace commands do not cover.
 * @param target - the profile and its bundle-resolution anchor.
 * @param args - pnpm arguments, verbatim from the command line.
 * @param cwd - the directory the command was invoked from, for anchoring relative path specs.
 * @param warn - sink for first-use, reconciliation, and failure notices.
 * @returns pnpm's exit code.
 */
export function forward(
  target: ProfileTarget, args: readonly string[], cwd: string, warn: ReconcileWarn,
): number {
  const profileDir = resolveProfileDir(target.profile, target.home)
  ensureProfile(target.profile, profileDir, warn)
  const before = readProfileManifest(BIN_NAME, profileDir)
  const run = runPackageManager({
    cwd: profileDir,
    args: args.map(argument => anchorPathSpec(argument, cwd)),
    stdio: 'inherit',
  })
  if (run.exitCode === 0) {
    reconcileBundles(before, profileDir, target.installAnchor, warn)
    return 0
  }
  // pnpm's own diagnostics name pnpm-workspace.yaml without saying WHICH
  // one; the profile owns it, and the commonest failure here is pnpm >= 10
  // blocking a git dependency's prepare (build) script until allowlisted.
  warn(`pnpm failed in profile directory ${profileDir}`)
  if (args.some(argument => /^git\+|^github:|\.git(?:#|$)/.test(argument))) {
    warn(
      'git-hosted plugins build on install via their prepare script, which pnpm blocks until allowed — '
      + `add the exact key pnpm printed above under allowBuilds in ${join(profileDir, 'pnpm-workspace.yaml')}, then re-run`,
    )
  }
  return run.exitCode
}
