import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_PROFILE_BUNDLES } from '@deepseek-ai/dsh-app-boot'
import {
  forward,
  install,
  list,
  PluginInstallError,
  resolve as resolveInstall,
  uninstall,
} from '@deepseek-ai/dsh-plugin-install'
import { pluginId } from '@deepseek-ai/dsh-plugin-manifest'
import {
  cleanupFixtures,
  fixture,
  PACKAGE_MANAGER_TIMEOUT_MS,
  packPlugin,
  PROFILE,
  readManifest,
  writeManifest,
} from './fixture.ts'

const slow = { timeout: PACKAGE_MANAGER_TIMEOUT_MS }

/** A profile someone created by hand: a bare manifest with no `dsh` section at all. */
function handmadeProfile(profileDir: string): void {
  mkdirSync(profileDir, { recursive: true })
  writeManifest(profileDir, { name: 'dsh-profile-handmade' })
  writeFileSync(join(profileDir, 'pnpm-workspace.yaml'), 'packages:\n  - .\n\nnodeLinker: hoisted\nautoInstallPeers: false\n')
}

afterEach(() => {
  vi.unstubAllEnvs()
  cleanupFixtures()
})

describe('resolve', () => {
  it('anchors a relative tarball path against the invoking directory', () => {
    const { home, installAnchor } = fixture()
    const spec = resolveInstall({
      profile: PROFILE, home, installAnchor, tarball: './out/sample-1.0.0.tgz', cwd: '/work/checkout',
    })
    expect(spec.packageSpec).toBe(join('/work/checkout', 'out', 'sample-1.0.0.tgz'))
    expect(spec.provenance).toEqual({ origin: 'tarball', tarball: spec.packageSpec })
  })

  it('anchors against the process working directory when the caller names none', () => {
    const { home, installAnchor } = fixture()
    const spec = resolveInstall({ profile: PROFILE, home, installAnchor, tarball: './sample-1.0.0.tgz' })
    expect(spec.packageSpec).toBe(join(process.cwd(), 'sample-1.0.0.tgz'))
  })

  it('keeps a remote tarball URL verbatim and records the catalog facts', () => {
    const { home, installAnchor } = fixture()
    const spec = resolveInstall({
      profile: PROFILE,
      home,
      installAnchor,
      tarball: 'https://catalog.test/sample-1.0.0.tgz',
      origin: 'marketplace',
      version: '1.0.0',
    })
    expect(spec.packageSpec).toBe('https://catalog.test/sample-1.0.0.tgz')
    expect(spec.provenance).toEqual({
      origin: 'marketplace',
      tarball: 'https://catalog.test/sample-1.0.0.tgz',
      version: '1.0.0',
    })
  })

  it('resolves the profile directory under the given Harness home', () => {
    const { home, installAnchor, profileDir } = fixture()
    expect(resolveInstall({ profile: PROFILE, home, installAnchor, tarball: '/t.tgz' }).profileDir).toBe(profileDir)
  })
})

describe('install', () => {
  it('initializes the profile, mounts the bundle as a layer, and records provenance', slow, () => {
    const { root, home, installAnchor, profileDir } = fixture()
    const tarball = packPlugin(root, { name: 'dsh-plugin-sample', version: '1.0.0' })
    const notices: string[] = []

    const result = install(
      resolveInstall({ profile: PROFILE, home, installAnchor, tarball, origin: 'marketplace', version: '1.0.0' }),
      { warn: message => notices.push(message) },
    )

    expect(result.id).toBe('dsh-plugin-sample')
    expect(result.version).toBe('1.0.0')
    expect(result.bundle).toBe(true)
    expect(result.manifest?.displayName).toBe('Sample')
    expect(result.provenance).toMatchObject({ origin: 'marketplace', tarball, version: '1.0.0' })
    expect(Date.parse(result.provenance.installedAt)).not.toBeNaN()
    expect(notices).toEqual([`initialized profile ${PROFILE} at ${profileDir}`])

    const manifest = readManifest(profileDir)
    expect(manifest.dsh?.profile?.bundles).toContain('dsh-plugin-sample')
    expect(manifest.dsh?.marketplace?.installs?.['dsh-plugin-sample']).toEqual(result.provenance)
  })

  it('keeps the profile out of an enclosing pnpm workspace', slow, () => {
    const { root, home, installAnchor, profileDir } = fixture()
    const outer = join(root, 'outer-workspace')
    mkdirSync(outer, { recursive: true })
    // A `pnpm run` parent exports this; unscrubbed it would re-point the
    // nested pnpm at the outer workspace and leave the profile empty.
    vi.stubEnv('npm_config_workspace_dir', outer)
    const tarball = packPlugin(root, { name: 'dsh-plugin-sample', version: '1.0.0' })

    install(resolveInstall({ profile: PROFILE, home, installAnchor, tarball }))

    expect(readManifest(profileDir).dependencies).toHaveProperty('dsh-plugin-sample')
  })

  it('reports a dependency that declares no dsh.bundle instead of mounting it', slow, () => {
    const { root, home, installAnchor, profileDir } = fixture()
    const tarball = packPlugin(root, { name: 'dsh-plugin-plain', version: '1.0.0', bundle: false })
    const notices: string[] = []

    const result = install(resolveInstall({ profile: PROFILE, home, installAnchor, tarball }), {
      warn: message => notices.push(message),
    })

    expect(result.bundle).toBe(false)
    expect(notices).toContainEqual(expect.stringContaining('dsh-plugin-plain declares no dsh.bundle'))
    // The template list a first-use initialization seeded, and nothing else.
    expect(readManifest(profileDir).dsh?.profile?.bundles).toEqual([...DEFAULT_PROFILE_BUNDLES])
  })

  it('installs a package that publishes no dsh.plugin section', slow, () => {
    const { root, home, installAnchor } = fixture()
    const tarball = packPlugin(root, { name: 'dsh-plugin-bare', version: '1.0.0', marketplace: false })

    expect(install(resolveInstall({ profile: PROFILE, home, installAnchor, tarball })).manifest).toBeUndefined()
  })

  it('re-points an installed plugin at a newer tarball', slow, () => {
    const { root, home, installAnchor, profileDir } = fixture()
    const request = { profile: PROFILE, home, installAnchor }
    install(resolveInstall({ ...request, tarball: packPlugin(root, { name: 'dsh-plugin-sample', version: '1.0.0' }) }))

    const upgraded = packPlugin(root, { name: 'dsh-plugin-sample', version: '2.0.0' })
    const result = install(resolveInstall({ ...request, tarball: upgraded, origin: 'marketplace', version: '2.0.0' }))

    expect(result.version).toBe('2.0.0')
    expect(readManifest(profileDir).dsh?.profile?.bundles).toEqual([...DEFAULT_PROFILE_BUNDLES, 'dsh-plugin-sample'])
    expect(readManifest(profileDir).dsh?.marketplace?.installs?.['dsh-plugin-sample']?.version).toBe('2.0.0')
  })

  it('is idempotent when the profile already holds the requested tarball', slow, () => {
    const { root, home, installAnchor, profileDir } = fixture()
    const request = { profile: PROFILE, home, installAnchor, tarball: packPlugin(root, { name: 'dsh-plugin-sample', version: '1.0.0' }) }
    install(resolveInstall(request))

    const result = install(resolveInstall(request))

    expect(result.id).toBe('dsh-plugin-sample')
    expect(readManifest(profileDir).dsh?.profile?.bundles).toEqual([...DEFAULT_PROFILE_BUNDLES, 'dsh-plugin-sample'])
  })

  it('refuses to guess when no single dependency records the tarball', slow, () => {
    const { root, home, installAnchor, profileDir } = fixture()
    const spec = resolveInstall({
      profile: PROFILE, home, installAnchor, tarball: packPlugin(root, { name: 'dsh-plugin-sample', version: '1.0.0' }),
    })
    install(spec)
    // A hand-edited profile that records the same tarball twice: reinstalling
    // it moves nothing, and two entries claim the specifier.
    const manifest = readManifest(profileDir)
    manifest.dependencies = { ...manifest.dependencies, 'dsh-plugin-alias': `file:${spec.packageSpec}` }
    writeManifest(profileDir, manifest)

    expect(() => install(spec)).toThrow(PluginInstallError)
    expect(() => install(spec)).toThrow(/matches several profile dependencies \(dsh-plugin-sample, dsh-plugin-alias\)/)
  })

  it('reports a package-manager failure with its captured diagnostics', slow, () => {
    const { root, home, installAnchor } = fixture()

    expect(() => install(resolveInstall({
      profile: PROFILE, home, installAnchor, tarball: join(root, 'absent-1.0.0.tgz'),
    }))).toThrow(/pnpm failed to install .*absent-1\.0\.0\.tgz.* \(exit \d+\): /)
  })

  it('reports a package-manager failure with no detail when the caller streamed the run', slow, () => {
    const { root, home, installAnchor } = fixture()

    expect(() => install(
      resolveInstall({ profile: PROFILE, home, installAnchor, tarball: join(root, 'absent-1.0.0.tgz') }),
      { stdio: 'inherit' },
    )).toThrow(/\(exit \d+\)$/)
  })

  it('installs into a hand-made profile that declares neither dependencies nor a dsh section', slow, () => {
    const { root, home, installAnchor, profileDir } = fixture()
    handmadeProfile(profileDir)
    const tarball = packPlugin(root, { name: 'dsh-plugin-sample', version: '1.0.0' })

    const result = install(resolveInstall({ profile: PROFILE, home, installAnchor, tarball }))

    expect(result.bundle).toBe(true)
    expect(readManifest(profileDir).dsh?.profile?.bundles).toEqual(['dsh-plugin-sample'])
  })
})

describe('uninstall', () => {
  it('removes the dependency and retires its patch layer', slow, () => {
    const { root, home, installAnchor, profileDir } = fixture()
    const tarball = packPlugin(root, { name: 'dsh-plugin-sample', version: '1.0.0' })
    install(resolveInstall({ profile: PROFILE, home, installAnchor, tarball }))

    const result = uninstall({ profile: PROFILE, home, installAnchor }, pluginId('dsh-plugin-sample'))

    expect(result).toEqual({ id: 'dsh-plugin-sample', bundle: true })
    const manifest = readManifest(profileDir)
    expect(manifest.dependencies).toBeUndefined()
    expect(manifest.dsh?.profile?.bundles).toEqual([...DEFAULT_PROFILE_BUNDLES])
    expect(manifest.dsh?.marketplace?.installs).toEqual({})
  })

  it('reports a profile that was never initialized', () => {
    const { home, installAnchor } = fixture()

    expect(() => uninstall({ profile: PROFILE, home, installAnchor }, pluginId('dsh-plugin-sample')))
      .toThrowError(expect.objectContaining({ code: 'PLUGIN_INSTALL_NOT_INSTALLED' }))
  })

  it('reports a package the profile does not depend on', slow, () => {
    const { root, home, installAnchor } = fixture()
    install(resolveInstall({
      profile: PROFILE, home, installAnchor, tarball: packPlugin(root, { name: 'dsh-plugin-sample', version: '1.0.0' }),
    }))

    expect(() => uninstall({ profile: PROFILE, home, installAnchor }, pluginId('dsh-plugin-absent')))
      .toThrow(/does not depend on dsh-plugin-absent/)
  })

  it('reports a package-manager failure', slow, () => {
    const { root, home, installAnchor, profileDir } = fixture()
    install(resolveInstall({
      profile: PROFILE, home, installAnchor, tarball: packPlugin(root, { name: 'dsh-plugin-sample', version: '1.0.0' }),
    }))
    // pnpm refuses to run against a manifest it cannot parse.
    writeFileSync(join(profileDir, 'pnpm-workspace.yaml'), 'packages: [\n')

    expect(() => uninstall({ profile: PROFILE, home, installAnchor }, pluginId('dsh-plugin-sample')))
      .toThrow(/pnpm failed to remove dsh-plugin-sample/)
  })

  it('leaves a plain dependency unreported as a layer', slow, () => {
    const { root, home, installAnchor } = fixture()
    install(resolveInstall({
      profile: PROFILE,
      home,
      installAnchor,
      tarball: packPlugin(root, { name: 'dsh-plugin-plain', version: '1.0.0', bundle: false }),
    }))

    expect(uninstall({ profile: PROFILE, home, installAnchor }, pluginId('dsh-plugin-plain')).bundle).toBe(false)
  })

  it('removes a package this profile never recorded provenance for', slow, () => {
    const { root, home, installAnchor, profileDir } = fixture()
    const tarball = packPlugin(root, { name: 'dsh-plugin-sample', version: '1.0.0' })
    // `dsh plugin add` forwards to pnpm without a marketplace record.
    forward({ profile: PROFILE, home, installAnchor }, ['add', tarball], root, () => {})
    expect(list({ profile: PROFILE, home, installAnchor })[0]?.provenance).toBeUndefined()

    expect(uninstall({ profile: PROFILE, home, installAnchor }, pluginId('dsh-plugin-sample')).bundle).toBe(true)
    expect(readManifest(profileDir).dsh?.marketplace).toBeUndefined()
  })

  it('removes a plain dependency from a hand-made profile that mounts no layers', slow, () => {
    const { root, home, installAnchor, profileDir } = fixture()
    handmadeProfile(profileDir)
    const request = { profile: PROFILE, home, installAnchor }
    install(resolveInstall({ ...request, tarball: packPlugin(root, { name: 'dsh-plugin-plain', version: '1.0.0', bundle: false }) }))
    expect(readManifest(profileDir).dsh?.profile).toBeUndefined()
    expect(list(request).map(plugin => plugin.bundle)).toEqual([false])

    expect(uninstall(request, pluginId('dsh-plugin-plain')).bundle).toBe(false)
  })
})

describe('list', () => {
  it('answers empty for a profile that does not exist', () => {
    const { home, installAnchor } = fixture()

    expect(list({ profile: PROFILE, home, installAnchor })).toEqual([])
  })

  it('reports every dependency with its layer state, metadata, and provenance', slow, () => {
    const { root, home, installAnchor } = fixture()
    const request = { profile: PROFILE, home, installAnchor }
    const tarball = packPlugin(root, { name: 'dsh-plugin-sample', version: '1.0.0' })
    install(resolveInstall({ ...request, tarball, origin: 'marketplace', version: '1.0.0' }))
    install(resolveInstall({
      ...request, tarball: packPlugin(root, { name: 'dsh-plugin-plain', version: '2.1.0', bundle: false }),
    }))

    expect(list(request)).toEqual([
      {
        id: 'dsh-plugin-plain',
        version: '2.1.0',
        bundle: false,
        manifest: expect.objectContaining({ id: 'dsh-plugin-plain' }),
        provenance: expect.objectContaining({ origin: 'tarball' }),
      },
      {
        id: 'dsh-plugin-sample',
        version: '1.0.0',
        bundle: true,
        manifest: expect.objectContaining({ id: 'dsh-plugin-sample' }),
        provenance: expect.objectContaining({ origin: 'marketplace', version: '1.0.0' }),
      },
    ])
  })

  it('reports an unresolvable or version-less dependency without failing', slow, () => {
    const { root, home, installAnchor, profileDir } = fixture()
    const request = { profile: PROFILE, home, installAnchor }
    install(resolveInstall({
      ...request, tarball: packPlugin(root, { name: 'dsh-plugin-sample', version: '1.0.0' }),
    }))
    const versionless = join(profileDir, 'node_modules', 'dsh-plugin-versionless')
    mkdirSync(versionless, { recursive: true })
    writeFileSync(join(versionless, 'package.json'), JSON.stringify({ name: 'dsh-plugin-versionless' }))
    const manifest = readManifest(profileDir)
    manifest.dependencies = {
      ...manifest.dependencies,
      'dsh-plugin-absent': '^1.0.0',
      'dsh-plugin-versionless': '^1.0.0',
    }
    writeManifest(profileDir, manifest)

    expect(list(request).map(plugin => [plugin.id, plugin.version, plugin.manifest, plugin.provenance])).toEqual([
      ['dsh-plugin-absent', 'unknown', undefined, undefined],
      ['dsh-plugin-sample', '1.0.0', expect.objectContaining({ id: 'dsh-plugin-sample' }), expect.anything()],
      ['dsh-plugin-versionless', 'unknown', undefined, undefined],
    ])
  })
})

describe('forward', () => {
  it('initializes the profile, runs pnpm verbatim, and reconciles the layer stack', slow, () => {
    const { root, home, installAnchor, profileDir } = fixture()
    const tarball = packPlugin(root, { name: 'dsh-plugin-sample', version: '1.0.0' })
    const notices: string[] = []

    expect(forward({ profile: PROFILE, home, installAnchor }, ['add', tarball], root, message => notices.push(message)))
      .toBe(0)

    expect(readManifest(profileDir).dsh?.profile?.bundles).toEqual([...DEFAULT_PROFILE_BUNDLES, 'dsh-plugin-sample'])
    expect(notices).toContainEqual(`initialized profile ${PROFILE} at ${profileDir}`)
  })

  it('anchors a relative path argument against the invoking directory', slow, () => {
    const { root, home, installAnchor, profileDir } = fixture()
    packPlugin(root, { name: 'dsh-plugin-sample', version: '1.0.0' })

    expect(forward(
      { profile: PROFILE, home, installAnchor }, ['add', './dsh-plugin-sample-1.0.0.tgz'], root, () => {},
    )).toBe(0)

    expect(readManifest(profileDir).dependencies).toHaveProperty('dsh-plugin-sample')
  })

  it('names the profile directory when pnpm fails', slow, () => {
    const { root, home, installAnchor, profileDir } = fixture()
    const notices: string[] = []

    expect(forward(
      { profile: PROFILE, home, installAnchor }, ['add', join(root, 'absent.tgz')], root, message => notices.push(message),
    )).not.toBe(0)

    expect(notices).toContainEqual(`pnpm failed in profile directory ${profileDir}`)
    expect(notices).not.toContainEqual(expect.stringContaining('allowBuilds'))
  })

  it('explains the allowBuilds prompt when a git-hosted plugin fails', slow, () => {
    const { root, home, installAnchor } = fixture()
    const notices: string[] = []

    expect(forward(
      { profile: PROFILE, home, installAnchor },
      ['add', `git+file://${join(root, 'absent-repository.git')}`],
      root,
      message => notices.push(message),
    )).not.toBe(0)

    expect(notices).toContainEqual(expect.stringContaining('allowBuilds'))
  })
})
