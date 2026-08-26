import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execa, type Result } from 'execa'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

/**
 * The marketplace install flow end to end, through the real `dsh` command line
 * and a real profile: pack the in-repo sample plugin, point a static catalog at
 * the tarball, then search, show, install, relaunch, and uninstall.
 *
 * Keyless and offline — a packed tarball with no dependencies never reaches a
 * registry, and no verb here talks to a model. The relaunch assertion is the
 * point of the suite: installing writes `dsh.profile.bundles`, and only the
 * next launch composes that layer into the tree, so a run that stopped at the
 * manifest would not prove the plugin ever mounts.
 */

const repoRoot = fileURLToPath(new URL('../../../', import.meta.url))
const samplePlugin = join(repoRoot, 'examples', 'marketplace', 'hello-plugin')
const SAMPLE_ID = 'dsh-plugin-hello-marketplace'
const PROFILE = 'marketplace-e2e'

let home: string
let catalog: string

/** Run one `dsh` invocation from source against the fixture Harness home. */
async function dsh(...args: readonly string[]): Promise<Result> {
  return execa(process.execPath, ['--import', 'tsx/esm', 'apps/cli/src/bin.ts', ...args], {
    cwd: repoRoot,
    env: { DSH_HOME: home },
    timeout: 120_000,
    reject: false,
  })
}

/** Run one `dsh marketplace` verb against the fixture catalog. */
async function marketplace(...args: readonly string[]): Promise<Result> {
  return dsh('marketplace', '--profile', PROFILE, '--index', join(catalog, 'index.json'), ...args)
}

/** The profile manifest as it stands on disk. */
async function profileManifest(): Promise<{
  dependencies?: Record<string, string>
  dsh?: { profile?: { bundles?: string[] }; marketplace?: { installs?: Record<string, { origin: string; version?: string }> } }
}> {
  return JSON.parse(await readFile(join(home, 'profiles', PROFILE, 'package.json'), 'utf8')) as never
}

beforeAll(async () => {
  home = await mkdtemp(join(tmpdir(), 'dsh-marketplace-home-'))
  catalog = join(home, 'catalog')
  await mkdir(catalog, { recursive: true })
  await cp(join(repoRoot, 'examples', 'marketplace', 'index.json'), join(catalog, 'index.json'))
  const packed = await execa('pnpm', ['pack', '--pack-destination', catalog], { cwd: samplePlugin, reject: false })
  if (packed.exitCode !== 0) throw new Error(`packing the sample plugin failed: ${packed.stderr}`)
}, 180_000)

afterAll(async () => {
  await rm(home, { recursive: true, force: true })
})

describe('dsh marketplace', () => {
  it('finds the sample plugin and shows its declared, unenforced capabilities', async () => {
    const found = await marketplace('search', 'hello')
    expect(found.exitCode).toBe(0)
    expect(found.stdout).toContain(`${SAMPLE_ID}@0.1.0`)

    const shown = await marketplace('show', SAMPLE_ID)
    expect(shown.exitCode).toBe(0)
    expect(shown.stdout).toContain('declared:    tools: none; filesystem: none; network: none; subprocess: no')
    expect(shown.stdout).toContain('not enforced')
  })

  it('rejects a catalog entry whose manifest is invalid', async () => {
    const index = JSON.parse(await readFile(join(catalog, 'index.json'), 'utf8')) as { plugins: Record<string, unknown>[] }
    delete index.plugins[0]?.publisher
    const broken = join(catalog, 'broken.json')
    await writeFile(broken, JSON.stringify(index))

    const result = await dsh('marketplace', '--profile', PROFILE, '--index', broken, 'search')

    expect(result.exitCode).toBe(1)
    expect(result.stderr).toContain('invalid dsh.plugin section: $.publisher missing required value')
  })

  it('installs into a fresh profile, mounts the layer on the next launch, and uninstalls again', async () => {
    const installed = await marketplace('install', SAMPLE_ID)
    expect(installed.exitCode).toBe(0)
    expect(installed.stdout).toContain(`installed ${SAMPLE_ID}@0.1.0 into profile ${PROFILE}`)
    expect(installed.stdout).toContain(`relaunch dsh --profile ${PROFILE}`)

    const afterInstall = await profileManifest()
    expect(afterInstall.dsh?.profile?.bundles).toEqual(['@deepseek-ai/dsh-base', SAMPLE_ID])
    expect(afterInstall.dsh?.marketplace?.installs?.[SAMPLE_ID])
      .toMatchObject({ origin: 'marketplace', version: '0.1.0' })

    const listed = await marketplace('list')
    expect(listed.stdout).toContain(`${SAMPLE_ID}@0.1.0  (layer)`)
    expect((await marketplace('updates')).stdout).toContain('matches the catalog')

    // The launcher reads dsh.profile.bundles at boot; this is the layer arriving.
    const relaunched = await dsh('--profile', PROFILE, '--dump-config')
    expect(relaunched.exitCode).toBe(0)
    expect(relaunched.stdout).toContain(`# == ${SAMPLE_ID}`)
    expect(relaunched.stdout).toContain('- id: hello-marketplace')

    const removed = await marketplace('uninstall', SAMPLE_ID)
    expect(removed.exitCode).toBe(0)
    expect((await profileManifest()).dsh?.profile?.bundles).toEqual(['@deepseek-ai/dsh-base'])

    const withoutLayer = await dsh('--profile', PROFILE, '--dump-config')
    expect(withoutLayer.stdout).not.toContain('hello-marketplace')
  }, 180_000)
})
