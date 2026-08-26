/**
 * Vocabulary for profile plugin installation: what a caller asks for, what the
 * resolved specification carries, and what a profile records about how each
 * plugin got there.
 * @module @deepseek-ai/dsh-plugin-install/types
 */

import { HarnessError } from '@deepseek-ai/dsh-llm'
import type { PluginId, PluginManifest } from '@deepseek-ai/dsh-plugin-manifest'

declare module '@deepseek-ai/dsh-app-boot' {
  interface DshManifestSection {
    /** Install provenance this package records in the profile manifest. */
    marketplace?: DshMarketplaceSection
  }
}

/** The `dsh.marketplace` section of a profile's package.json. */
export interface DshMarketplaceSection {
  /** Install provenance keyed by installed package name. */
  installs?: Record<string, PluginProvenance>
}

/**
 * How one package entered a profile. `marketplace` means a catalog listing
 * named the tarball; `tarball` means a caller supplied the location directly.
 */
export type PluginOrigin = 'marketplace' | 'tarball'

/**
 * What a profile records about one installed plugin. Provenance is the profile's
 * own record, not the package's claim: it says what this profile fetched and
 * when, so a later audit can tell a catalog install from a hand-supplied file
 * even after the catalog changes.
 */
export interface PluginProvenance {
  /** Whether a catalog listing or a direct location named the tarball. */
  readonly origin: PluginOrigin
  /** The tarball location the install fetched, as resolved. */
  readonly tarball: string
  /** The catalog release version, when the install came from a catalog. */
  readonly version?: string
  /** ISO-8601 timestamp of the install. */
  readonly installedAt: string
}

/** Which profile an operation acts on and how bundle packages resolve for it. */
export interface ProfileTarget {
  /** The profile name under `$DSH_HOME/profiles`. */
  readonly profile: string
  /**
   * Absolute path of the launching app's package.json. Bundle resolution tries
   * this anchor before the profile directory, so an in-box bundle always comes
   * from the running installation.
   */
  readonly installAnchor: string
  /** The Harness home; defaults to the resolver's own answer. */
  readonly home?: string
}

/** An install request: a profile plus the tarball to put in it. */
export interface InstallRequest extends ProfileTarget {
  /**
   * The packed tarball: a filesystem path (relative paths resolve against
   * `cwd`) or an `https:` URL. Marketplace installs are tarball-only, so no
   * publisher build script runs during the install.
   */
  readonly tarball: string
  /** Where a relative `tarball` path resolves from; defaults to the process working directory. */
  readonly cwd?: string
  /** Whether a catalog listing named this tarball. Defaults to `tarball`. */
  readonly origin?: PluginOrigin
  /** The catalog release version, recorded in provenance when the install came from a catalog. */
  readonly version?: string
}

/** A fully resolved install: every default applied, nothing left for the executor to decide. */
export interface InstallSpec {
  /** The profile name, which also selects the template a first-use initialization applies. */
  readonly profile: string
  /** The absolute profile directory. */
  readonly profileDir: string
  /** The package-manager argument: an absolute path or an `https:` URL. */
  readonly packageSpec: string
  /** The absolute app package.json used as the first bundle-resolution anchor. */
  readonly installAnchor: string
  /** The provenance to record once the install succeeds, minus its timestamp. */
  readonly provenance: Omit<PluginProvenance, 'installedAt'>
}

/** What one installed plugin looks like to a caller listing a profile. */
export interface InstalledPlugin {
  /** The installed package name. */
  readonly id: PluginId
  /** The installed version, read from the resolved package. */
  readonly version: string
  /** Whether the profile mounts this package as a patch layer (it declares `dsh.bundle`). */
  readonly bundle: boolean
  /** The package's `dsh.plugin` marketplace metadata, when it publishes one. */
  readonly manifest?: PluginManifest
  /** What this profile recorded when it installed the package, when it has a record. */
  readonly provenance?: PluginProvenance
}

/** The outcome of one install. */
export interface InstallResult {
  /** The package name the tarball actually installed under. */
  readonly id: PluginId
  /** The installed version. */
  readonly version: string
  /** Whether the package joined `dsh.profile.bundles` as a patch layer. */
  readonly bundle: boolean
  /** The package's `dsh.plugin` metadata, when it publishes one. */
  readonly manifest?: PluginManifest
  /** The provenance recorded in the profile manifest. */
  readonly provenance: PluginProvenance
}

/** The outcome of one uninstall. */
export interface UninstallResult {
  /** The package name removed. */
  readonly id: PluginId
  /** Whether the package had been mounted as a patch layer before removal. */
  readonly bundle: boolean
}

/**
 * Typed install error with a machine-routable `code`. Codes:
 * `PLUGIN_INSTALL_PACKAGE_MANAGER_MISSING` (pnpm is not on PATH),
 * `PLUGIN_INSTALL_FAILED` (the package manager exited non-zero),
 * `PLUGIN_INSTALL_NO_PACKAGE` (the install added no new dependency, so no
 * plugin can be named), and `PLUGIN_INSTALL_NOT_INSTALLED` (an uninstall named
 * a package the profile does not depend on).
 */
export class PluginInstallError extends HarnessError {}
