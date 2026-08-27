/**
 * Shared fixture for the profile-installation suites: a throwaway Harness home,
 * a launcher anchor that resolves nothing, and real packed tarballs.
 *
 * The suites drive the real package manager against real tarballs because the
 * behavior under test IS what pnpm writes into a profile — which dependency
 * name a tarball lands under, and whether the installed package declares
 * `dsh.bundle`. A stubbed runner would assert the stub.
 * @module @deepseek-ai/dsh-plugin-install/tests/fixture
 */

import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ProfileManifest } from '@deepseek-ai/dsh-app-boot'

/** The profile name every suite installs into. */
export const PROFILE = 'testing'

/** Budget for one test that packs and installs; a cold pnpm store dominates it. */
export const PACKAGE_MANAGER_TIMEOUT_MS = 120_000

/** One throwaway installation: a Harness home, a launcher anchor, and a scratch root. */
export interface Fixture {
  /** Scratch root holding everything this fixture created. */
  readonly root: string
  /** The Harness home whose `profiles/` subtree the operations write. */
  readonly home: string
  /** Absolute package.json of a launcher app that resolves no bundles. */
  readonly installAnchor: string
  /** The profile directory {@link PROFILE} resolves to. */
  readonly profileDir: string
}

/** Every fixture this file created, torn down by {@link cleanupFixtures}. */
const created: string[] = []

/**
 * Build one throwaway fixture.
 * @returns the fixture paths; the directories other than `root` are created on demand.
 */
export function fixture(): Fixture {
  const root = mkdtempSync(join(tmpdir(), 'dsh-plugin-install-'))
  created.push(root)
  const appDir = join(root, 'app')
  mkdirSync(appDir, { recursive: true })
  writeFileSync(
    join(appDir, 'package.json'),
    JSON.stringify({ name: 'dsh-app-fixture', version: '0.0.0', dependencies: {} }),
  )
  const home = join(root, 'home')
  return { root, home, installAnchor: join(appDir, 'package.json'), profileDir: join(home, 'profiles', PROFILE) }
}

/** Remove every fixture root created so far. */
export function cleanupFixtures(): void {
  for (const root of created.splice(0)) rmSync(root, { recursive: true, force: true })
}

/** What {@link packPlugin} puts in the package it packs. */
export interface PackedPlugin {
  /** The package name, which is also the dependency name the profile records. */
  readonly name: string
  /** The package version. */
  readonly version: string
  /** Whether the package declares `dsh.bundle`, i.e. mounts as a profile patch layer. Defaults to true. */
  readonly bundle?: boolean
  /** Whether the package declares a `dsh.plugin` marketplace section. Defaults to true. */
  readonly marketplace?: boolean
}

/** The `dsh.plugin` section a marketplace-declaring sample publishes. */
const SAMPLE_SECTION = {
  displayName: 'Sample',
  description: 'a packed sample',
  publisher: 'plugin-install tests',
  capabilities: { tools: [], filesystem: 'none', network: 'none', subprocess: false },
}

/**
 * Pack one sample package into a real npm tarball.
 * @param root - the directory the tarball and the source tree are written under.
 * @param plugin - what the packed package declares.
 * @returns the absolute tarball path.
 */
export function packPlugin(root: string, plugin: PackedPlugin): string {
  const dir = join(root, `pack-${plugin.name}-${plugin.version}`)
  mkdirSync(join(dir, 'lib'), { recursive: true })
  writeFileSync(join(dir, 'lib', 'index.js'), 'export const name = "sample"\nexport function apply() {}\n')
  writeFileSync(join(dir, 'cordis.patch.yml'), '[]\n')
  writeFileSync(join(dir, 'package.json'), JSON.stringify({
    name: plugin.name,
    version: plugin.version,
    private: true,
    type: 'module',
    main: 'lib/index.js',
    files: ['lib/index.js', 'cordis.patch.yml'],
    dsh: {
      ...(plugin.bundle ?? true) ? { bundle: { patch: './cordis.patch.yml' } } : {},
      ...(plugin.marketplace ?? true) ? { plugin: SAMPLE_SECTION } : {},
    },
  }))
  const run = spawnSync('pnpm', ['pack', '--pack-destination', root], { cwd: dir, encoding: 'utf8' })
  if (run.status !== 0) throw new Error(`pnpm pack failed for ${plugin.name}: ${run.stderr}`)
  return join(root, `${plugin.name}-${plugin.version}.tgz`)
}

/**
 * Read a profile's manifest from disk.
 * @param profileDir - the profile directory.
 * @returns the parsed manifest.
 */
export function readManifest(profileDir: string): ProfileManifest {
  return JSON.parse(readFileSync(join(profileDir, 'package.json'), 'utf8')) as ProfileManifest
}

/**
 * Overwrite a profile's manifest.
 * @param profileDir - the profile directory.
 * @param manifest - the manifest to persist.
 */
export function writeManifest(profileDir: string, manifest: ProfileManifest): void {
  writeFileSync(join(profileDir, 'package.json'), `${JSON.stringify(manifest, undefined, 2)}\n`)
}
