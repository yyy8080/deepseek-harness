/**
 * Reconcile a profile's `dsh.profile.bundles` layer list against its installed
 * state.
 *
 * Reconciling by installed state, not by dependency diff, means an update that
 * gives a package its first `dsh.bundle` declaration activates it as a layer,
 * and an update that drops the declaration retires the layer. The package
 * manager has already written the real installed names, so a tarball, git,
 * path, or alias spec on the command line reconciles under the name it
 * actually installed as.
 * @module @deepseek-ai/dsh-plugin-install/reconcile
 */

import {
  readProfileManifest,
  resolveBundleDir,
  writeProfileManifest,
  type ProfileManifest,
} from '@deepseek-ai/dsh-app-boot'

/** The diagnostic prefix profile-manifest failures carry. */
export const BIN_NAME = 'dsh'

/**
 * Resolve one of a profile's dependencies to its installed package directory.
 * @param packageName - the dependency name.
 * @param profileDir - the profile directory (second resolution anchor).
 * @param installAnchor - the launching app's package.json (first resolution anchor).
 * @returns the package directory, or `undefined` when it does not resolve.
 */
export function resolveInstalledDir(
  packageName: string, profileDir: string, installAnchor: string,
): string | undefined {
  try {
    return resolveBundleDir(BIN_NAME, packageName, installAnchor, profileDir)
  } catch {
    return undefined // the package manager reported success yet the package is unresolvable
  }
}

/** Whether a resolved dependency exports a profile patch, i.e. is a bundle. */
function exportsPatch(packageName: string, profileDir: string, installAnchor: string): boolean {
  const dir = resolveInstalledDir(packageName, profileDir, installAnchor)
  if (dir === undefined) return false
  return readProfileManifest(BIN_NAME, dir).dsh?.bundle?.patch !== undefined
}

/** Where reconciliation reports a dependency that turned out not to be a layer. */
export type ReconcileWarn = (message: string) => void

/**
 * Reconcile `dsh.profile.bundles` after a package-manager run.
 *
 * A dependency that resolves to a `dsh.bundle`-declaring package joins the
 * layer stack, appended in dependency order; a dependency-listed name that no
 * longer does — removed, or the installed version dropped the declaration —
 * leaves it. In-box bundles from the profile template are not dependencies and
 * are never touched.
 * @param before - the profile manifest as it was before the run.
 * @param profileDir - the profile directory.
 * @param installAnchor - the launching app's package.json.
 * @param warn - sink for the one-line notice a newly added bundle-less dependency produces; omitted stays silent.
 * @returns the bundle names added to the layer stack by this reconciliation.
 */
export function reconcileBundles(
  before: ProfileManifest, profileDir: string, installAnchor: string, warn?: ReconcileWarn,
): readonly string[] {
  const after = readProfileManifest(BIN_NAME, profileDir)
  const beforeDeps = new Set(Object.keys(before.dependencies ?? {}))
  const dependencies = Object.keys(after.dependencies ?? {})
  const bundles = after.dsh?.profile?.bundles ?? []
  const added: string[] = []
  for (const packageName of dependencies) {
    const isBundle = exportsPatch(packageName, profileDir, installAnchor)
    if (isBundle && !bundles.includes(packageName)) {
      bundles.push(packageName)
      added.push(packageName)
    } else if (!isBundle && !beforeDeps.has(packageName)) {
      warn?.(
        `${packageName} declares no dsh.bundle — installed as a plain dependency, not a profile layer `
        + '(a later update that gains one activates it automatically)',
      )
    }
  }
  const dependencySet = new Set(dependencies)
  let removed = false
  for (const packageName of [...bundles]) {
    // Only dependency-managed entries are subject to removal; template
    // bundles (dsh-base and friends) are not dependencies.
    const wasDependency = beforeDeps.has(packageName) || dependencySet.has(packageName)
    const stillBundle = dependencySet.has(packageName) && exportsPatch(packageName, profileDir, installAnchor)
    if (wasDependency && !stillBundle) {
      bundles.splice(bundles.indexOf(packageName), 1)
      removed = true
    }
  }
  if (added.length > 0 || removed) {
    after.dsh = { ...after.dsh, profile: { ...after.dsh?.profile, bundles } }
    writeProfileManifest(profileDir, after)
  }
  return added
}
