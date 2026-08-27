/**
 * `dsh plugin --profile <name> <args...>` — the raw pnpm escape hatch for a
 * profile's plugin dependencies. Everything it does lives in
 * `@deepseek-ai/dsh-plugin-install`; this module only supplies the launcher's
 * facts (which app installation resolves in-box bundles, where the user typed
 * the command) and prints the diagnostics.
 * @module @deepseek-ai/dsh/plugin
 */

import { forward, PluginInstallError } from '@deepseek-ai/dsh-plugin-install'
import { INSTALL_ANCHOR } from './profile-boot.ts'

const NAME = 'dsh'

/**
 * Run one `dsh plugin` invocation: init the profile if needed, forward to
 * pnpm, reconcile the profile's bundle layers.
 * @param profile - the profile name.
 * @param args - pnpm arguments, verbatim from argv.
 * @returns the pnpm exit code, or 127 when pnpm is not installed.
 */
export function runPlugin(profile: string, args: readonly string[]): number {
  const warn = (message: string): void => void process.stderr.write(`${NAME}: ${message}\n`)
  try {
    return forward({ profile, installAnchor: INSTALL_ANCHOR }, args, process.cwd(), warn)
  } catch (error) {
    if (error instanceof PluginInstallError && error.code === 'PLUGIN_INSTALL_PACKAGE_MANAGER_MISSING') {
      warn(error.message)
      return 127
    }
    throw error
  }
}
