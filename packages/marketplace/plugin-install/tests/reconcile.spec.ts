import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { ProfileManifest } from '@deepseek-ai/dsh-app-boot'
import { afterEach, describe, expect, it } from 'vitest'
import { reconcileBundles, resolveInstalledDir } from '@deepseek-ai/dsh-plugin-install/src/reconcile.ts'
import { cleanupFixtures, fixture, readManifest, writeManifest } from './fixture.ts'

afterEach(cleanupFixtures)

/** A profile directory holding the given manifest, with no package manager involved. */
function profile(manifest: ProfileManifest): { dir: string; installAnchor: string } {
  const { installAnchor, profileDir } = fixture()
  mkdirSync(profileDir, { recursive: true })
  writeManifest(profileDir, manifest)
  return { dir: profileDir, installAnchor }
}

/** Place one installed package under a profile's node_modules. */
function installed(profileDir: string, name: string, manifest: Record<string, unknown>): void {
  const dir = join(profileDir, 'node_modules', name)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name, version: '1.0.0', ...manifest }))
}

/** A package.json declaring a bundle patch layer. */
const BUNDLE = { dsh: { bundle: { patch: './cordis.patch.yml' } } }

describe('resolveInstalledDir', () => {
  it('resolves an installed dependency and answers undefined for an absent one', () => {
    const { dir, installAnchor } = profile({ dependencies: { present: '^1.0.0' } })
    installed(dir, 'present', {})

    expect(resolveInstalledDir('present', dir, installAnchor)).toBe(join(dir, 'node_modules', 'present'))
    expect(resolveInstalledDir('absent', dir, installAnchor)).toBeUndefined()
  })
})

describe('reconcileBundles', () => {
  it('appends every dependency that declares a patch layer, in dependency order', () => {
    const before: ProfileManifest = { dependencies: {}, dsh: { profile: { bundles: ['@deepseek-ai/dsh-base'] } } }
    const { dir, installAnchor } = profile({
      dependencies: { 'plugin-a': '^1.0.0', 'plugin-b': '^1.0.0' },
      dsh: { profile: { bundles: ['@deepseek-ai/dsh-base'] } },
    })
    installed(dir, 'plugin-a', BUNDLE)
    installed(dir, 'plugin-b', BUNDLE)

    expect(reconcileBundles(before, dir, installAnchor)).toEqual(['plugin-a', 'plugin-b'])
    expect(readManifest(dir).dsh?.profile?.bundles).toEqual(['@deepseek-ai/dsh-base', 'plugin-a', 'plugin-b'])
  })

  it('reports a newly added dependency that declares no patch layer', () => {
    const before: ProfileManifest = { dependencies: {} }
    const { dir, installAnchor } = profile({ dependencies: { 'plain-library': '^1.0.0' } })
    installed(dir, 'plain-library', {})
    const notices: string[] = []

    expect(reconcileBundles(before, dir, installAnchor, message => notices.push(message))).toEqual([])
    expect(notices).toEqual([expect.stringContaining('plain-library declares no dsh.bundle')])
  })

  it('stays silent about a bundle-less dependency that was already there', () => {
    const before: ProfileManifest = { dependencies: { 'plain-library': '^1.0.0' } }
    const { dir, installAnchor } = profile({ dependencies: { 'plain-library': '^1.0.0' } })
    installed(dir, 'plain-library', {})
    const notices: string[] = []

    reconcileBundles(before, dir, installAnchor, message => notices.push(message))

    expect(notices).toEqual([])
  })

  it('treats an unresolvable dependency as no layer', () => {
    const before: ProfileManifest = { dependencies: {} }
    const { dir, installAnchor } = profile({ dependencies: { 'never-installed': '^1.0.0' } })

    expect(reconcileBundles(before, dir, installAnchor)).toEqual([])
    expect(readManifest(dir).dsh?.profile?.bundles).toBeUndefined()
  })

  it('retires a layer whose dependency was removed', () => {
    const before: ProfileManifest = {
      dependencies: { 'plugin-a': '^1.0.0' },
      dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', 'plugin-a'] } },
    }
    const { dir, installAnchor } = profile({
      dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', 'plugin-a'] } },
    })

    reconcileBundles(before, dir, installAnchor)

    expect(readManifest(dir).dsh?.profile?.bundles).toEqual(['@deepseek-ai/dsh-base'])
  })

  it('retires a layer whose installed version dropped its patch declaration', () => {
    const before: ProfileManifest = {
      dependencies: { 'plugin-a': '^1.0.0' },
      dsh: { profile: { bundles: ['plugin-a'] } },
    }
    const { dir, installAnchor } = profile({
      dependencies: { 'plugin-a': '^2.0.0' },
      dsh: { profile: { bundles: ['plugin-a'] } },
    })
    installed(dir, 'plugin-a', {})

    reconcileBundles(before, dir, installAnchor)

    expect(readManifest(dir).dsh?.profile?.bundles).toEqual([])
  })

  it('leaves template bundles that were never dependencies alone', () => {
    const before: ProfileManifest = { dependencies: {}, dsh: { profile: { bundles: ['@deepseek-ai/dsh-base'] } } }
    const { dir, installAnchor } = profile({
      dependencies: {},
      dsh: { profile: { bundles: ['@deepseek-ai/dsh-base'] } },
    })

    reconcileBundles(before, dir, installAnchor)

    expect(readManifest(dir).dsh?.profile?.bundles).toEqual(['@deepseek-ai/dsh-base'])
  })
})
