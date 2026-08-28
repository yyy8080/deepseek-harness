/**
 * The pnpm invocation every profile plugin operation goes through: argument
 * anchoring, workspace-environment scrubbing, and the missing-pnpm diagnostic.
 * @module @deepseek-ai/dsh-plugin-install/package-manager
 */

import { spawnSync, type SpawnSyncReturns } from 'node:child_process'
import { resolve } from 'node:path'
import { PluginInstallError } from './types.ts'

/** The package manager a profile's out-of-tree dependencies are installed with. */
const PACKAGE_MANAGER = 'pnpm'

/**
 * Environment variables a parent `pnpm run` sets that would re-point a nested
 * pnpm at the OUTER workspace instead of the profile directory. Launching
 * `dsh` through a repository script would otherwise install the plugin into
 * that repository and leave the profile untouched.
 */
const WORKSPACE_SCOPE_ENV: ReadonlySet<string> = new Set(['npm_config_workspace_dir', 'NPM_CONFIG_WORKSPACE_DIR'])

/**
 * Rewrite a relative filesystem spec against the caller's invoking directory.
 * pnpm runs with cwd = the profile directory, so a bare `.` or `../plugin`
 * (or their `file:`/`link:` forms) would silently resolve inside the profile
 * — `add .` from a plugin checkout would self-link the profile. Absolute
 * specs, registry names, and every other pnpm argument pass through
 * untouched.
 * @param argument - one pnpm argument, verbatim from argv.
 * @param cwd - the directory the command was invoked from.
 * @returns the argument with a relative path spec anchored to `cwd`.
 */
export function anchorPathSpec(argument: string, cwd: string): string {
  const match = /^(?<prefix>(?:file|link):)?(?<path>\.{1,2}(?:[/\\].*)?)$/.exec(argument)
  if (match?.groups?.path === undefined) return argument
  // A bare path stays bare and a prefixed spec keeps its prefix: pnpm's
  // link-vs-copy semantics differ between `file:` and a plain directory
  // path, and the anchor must not change which one the user asked for.
  const prefix = match.groups.prefix ?? ''
  return `${prefix}${resolve(cwd, match.groups.path)}`
}

/** The environment a nested pnpm runs under: the caller's, minus the outer workspace scope. */
function childEnvironment(): NodeJS.ProcessEnv {
  return Object.fromEntries(Object.entries(process.env).filter(([key]) => !WORKSPACE_SCOPE_ENV.has(key)))
}

/** How one pnpm invocation reports itself. */
export interface PackageManagerRun {
  /** The profile directory pnpm runs in. */
  readonly cwd: string
  /** pnpm arguments, already anchored. */
  readonly args: readonly string[]
  /** `inherit` streams to this process; `pipe` captures for a programmatic caller. */
  readonly stdio: 'inherit' | 'pipe'
}

/** What one pnpm invocation produced. */
export interface PackageManagerResult {
  /** pnpm's exit code (1 when it failed without one). */
  readonly exitCode: number
  /**
   * The run's captured output, or an empty string under `inherit`. pnpm prints
   * its own diagnostics on standard output rather than standard error, so both
   * streams are joined: a caller explaining a failure needs whichever one the
   * reason landed on.
   */
  readonly output: string
}

/**
 * Run one pnpm invocation in a profile directory.
 * @param run - the directory, arguments, and stream disposition.
 * @returns the exit code and captured output.
 * @throws PluginInstallError `PLUGIN_INSTALL_PACKAGE_MANAGER_MISSING` when pnpm is not on PATH.
 */
export function runPackageManager(run: PackageManagerRun): PackageManagerResult {
  // Windows resolves pnpm through its .cmd shim, which spawn() refuses
  // without a shell since the CVE-2024-27980 hardening. The declared element
  // type widens to `| null` because `stdio: 'inherit'` hands both streams to
  // this process and leaves the captured pair empty, which @types/node's
  // encoding overload does not express.
  const result: SpawnSyncReturns<string | null> = spawnSync(PACKAGE_MANAGER, [...run.args], {
    cwd: run.cwd,
    stdio: run.stdio,
    shell: process.platform === 'win32',
    encoding: 'utf8',
    env: childEnvironment(),
  })
  if (result.error !== undefined) {
    if ((result.error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new PluginInstallError(
        `${PACKAGE_MANAGER} is not on PATH — install ${PACKAGE_MANAGER} to manage profile plugins`,
        'PLUGIN_INSTALL_PACKAGE_MANAGER_MISSING',
        { cause: result.error },
      )
    }
    throw result.error
  }
  // A signalled run reports no status; a plugin operation only distinguishes
  // success from failure, so any absent status counts as failure.
  return { exitCode: result.status ?? 1, output: `${result.stdout ?? ''}${result.stderr ?? ''}`.trim() }
}
