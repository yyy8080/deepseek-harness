/**
 * The assembled `dsh marketplace` transcript: every verb a person types, run
 * through the shipped command line against a real profile under a temporary
 * Harness home.
 *
 * Keyless and offline — the catalog is a static index on disk, the release is a
 * packed tarball with no dependencies, and no verb reaches a model. Three
 * families of value are replaced before the diff because this repository does
 * not own them: the temporary home and catalog directories, the install
 * timestamp, and the package manager's own progress block (`install` and
 * `uninstall` stream pnpm straight to this process's stdout, so its version,
 * timings, and resolution counts land in the transcript).
 *
 * The relaunch step is the point of the suite: installing only writes
 * `dsh.profile.bundles`, and the next launch composes that layer, so a
 * transcript that stopped at the install line would not show the plugin
 * mounting.
 */

import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execa } from 'execa'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

const repoRoot = fileURLToPath(new URL('../../../', import.meta.url))
const builtBin = join(repoRoot, 'apps/cli/lib/bin.js')
const samplePlugin = join(repoRoot, 'examples/marketplace/hello-plugin')
const SAMPLE_ID = 'dsh-plugin-hello-marketplace'
const PROFILE = 'marketplace-snapshot'
const builtArtifactsExist = existsSync(builtBin)

if (process.env.DSH_EXAMPLE_MODE === 'lib' && !builtArtifactsExist) {
  throw new Error('dsh marketplace snapshot requires a built CLI in lib mode')
}

let home: string
let catalog: string

/**
 * Replace the values that differ between two runs of the same flow.
 * @param text - one captured stream.
 * @returns the stream with run-specific values named.
 */
function normalize(text: string): string {
  return text
    .replaceAll(catalog, '{{catalog}}')
    .replaceAll(home, '{{home}}')
    .replace(/\d{4}-\d{2}-\d{2}T[\d:.]+Z/gu, '{{installedAt}}')
    .trimEnd()
}

/**
 * Drop the inherited package-manager block from a mutating verb's output.
 * `dsh` writes its own result lines after pnpm finishes, so the transcript
 * starts at the first line this repository produces.
 * @param stdout - the captured standard output.
 * @returns the dsh-owned tail of the run.
 */
function afterPackageManager(stdout: string): string {
  const lines = stdout.split('\n')
  const start = lines.findIndex(line => /^(?:installed|removed) /u.test(line))
  return normalize(lines.slice(start === -1 ? 0 : start).join('\n'))
}

/** One completed `dsh` run: exit code plus captured streams. */
interface Run {
  exitCode: number | undefined
  stdout: string
  stderr: string
}

/**
 * Run one `dsh` invocation against the fixture Harness home.
 * @param args - the command line after the bin name.
 * @returns the completed run.
 */
async function dsh(...args: readonly string[]): Promise<Run> {
  const { exitCode, stdout, stderr } = await execa(process.execPath, [builtBin, ...args], {
    cwd: repoRoot,
    env: { ...process.env, DSH_HOME: home, DSH_TELEMETRY_DISABLED: '1', NODE_NO_WARNINGS: '1' },
    timeout: 120_000,
    reject: false,
  })
  return { exitCode, stdout, stderr }
}

/**
 * Run one `dsh marketplace` verb against the fixture catalog.
 * @param args - the verb and its arguments.
 * @returns the completed run.
 */
async function marketplace(...args: readonly string[]): Promise<Run> {
  return dsh('marketplace', '--profile', PROFILE, '--index', join(catalog, 'index.json'), ...args)
}

beforeAll(async () => {
  home = mkdtempSync(join(tmpdir(), 'dsh-marketplace-snapshot-'))
  catalog = join(home, 'catalog')
  mkdirSync(catalog, { recursive: true })
  cpSync(join(repoRoot, 'examples/marketplace/index.json'), join(catalog, 'index.json'))
  const packed = await execa('pnpm', ['pack', '--pack-destination', catalog], { cwd: samplePlugin, reject: false })
  if (packed.exitCode !== 0) throw new Error(`packing the sample plugin failed: ${packed.stderr}`)
}, 180_000)

afterAll(() => {
  rmSync(home, { recursive: true, force: true })
})

describe.skipIf(!builtArtifactsExist)('dsh marketplace assembled snapshot', () => {
  it('browses the catalog, installs into a profile, mounts the layer on relaunch, and removes it', async () => {
    const found = await marketplace('search', 'hello')
    const shown = await marketplace('show', SAMPLE_ID)
    const installed = await marketplace('install', SAMPLE_ID)
    const listed = await marketplace('list')
    const updates = await marketplace('updates')
    const relaunched = await dsh('--profile', PROFILE, '--dump-config')
    const removed = await marketplace('uninstall', SAMPLE_ID)
    const withoutLayer = await dsh('--profile', PROFILE, '--dump-config')

    // The composed tree is the whole profile; only the marketplace layer and
    // its header belong to this flow.
    const composed = relaunched.stdout.split('\n')
    const layerStart = composed.findIndex(line => line.startsWith(`# == ${SAMPLE_ID}`))
    if (layerStart === -1) throw new Error(`the relaunched profile composed no ${SAMPLE_ID} layer:\n${relaunched.stdout}`)
    const mountedLayer = composed.slice(layerStart).join('\n')

    expect({
      exitCodes: [found, shown, installed, listed, updates, relaunched, removed, withoutLayer]
        .map(run => run.exitCode),
      search: normalize(found.stdout),
      show: normalize(shown.stdout),
      install: afterPackageManager(installed.stdout),
      installDiagnostics: normalize(installed.stderr),
      list: normalize(listed.stdout),
      updates: normalize(updates.stdout),
      mountedLayer: normalize(mountedLayer),
      uninstall: afterPackageManager(removed.stdout),
      layerAfterUninstall: withoutLayer.stdout.includes(SAMPLE_ID),
    }).toMatchInlineSnapshot(`
      {
        "exitCodes": [
          0,
          0,
          0,
          0,
          0,
          0,
          0,
          0,
        ],
        "install": "installed dsh-plugin-hello-marketplace@0.1.0 into profile marketplace-snapshot
        declared: tools: none; filesystem: none; network: none; subprocess: no
        note:     Declared by the publisher and not enforced: an installed plugin runs with full harness authority regardless of what it declares.
        the profile now mounts dsh-plugin-hello-marketplace as a patch layer — relaunch dsh --profile marketplace-snapshot to use it",
        "installDiagnostics": "dsh: initialized profile marketplace-snapshot at {{home}}/profiles/marketplace-snapshot",
        "layerAfterUninstall": false,
        "list": "dsh-plugin-hello-marketplace@0.1.0  (layer)
        Hello Marketplace — DeepSeek Harness examples
        installed {{installedAt}} from marketplace: {{catalog}}/dsh-plugin-hello-marketplace-0.1.0.tgz",
        "mountedLayer": "# == dsh-plugin-hello-marketplace
      - id: hello-marketplace
        name: dsh-plugin-hello-marketplace",
        "search": "dsh-plugin-hello-marketplace@0.1.0  Hello Marketplace
        A minimal profile bundle that mounts one greeting plugin, used to exercise the marketplace install flow end to end.
        publisher: DeepSeek Harness examples",
        "show": "dsh-plugin-hello-marketplace
        name:        Hello Marketplace
        publisher:   DeepSeek Harness examples
        homepage:    https://github.com/deepseek-ai/deepseek-harness/tree/master/examples/marketplace
        description: A minimal profile bundle that mounts one greeting plugin, used to exercise the marketplace install flow end to end.
        versions:    0.1.0
        declared:    tools: none; filesystem: none; network: none; subprocess: no
        note:        Declared by the publisher and not enforced: an installed plugin runs with full harness authority regardless of what it declares.",
        "uninstall": "removed dsh-plugin-hello-marketplace from profile marketplace-snapshot
        relaunch dsh --profile marketplace-snapshot to drop its patch layer",
        "updates": "profile marketplace-snapshot matches the catalog",
      }
    `)
  }, 180_000)

  it('refuses a catalog entry whose plugin manifest is invalid', async () => {
    const index = JSON.parse(readFileSync(join(catalog, 'index.json'), 'utf8')) as { plugins: Record<string, unknown>[] }
    delete index.plugins[0]?.publisher
    writeFileSync(join(catalog, 'broken.json'), JSON.stringify(index))

    const result = await dsh('marketplace', '--profile', PROFILE, '--index', join(catalog, 'broken.json'), 'search')

    expect({
      exitCode: result.exitCode,
      stdout: normalize(result.stdout),
      stderr: normalize(result.stderr),
    }).toMatchInlineSnapshot(`
      {
        "exitCode": 1,
        "stderr": "{{catalog}}/broken.json: invalid dsh.plugin section: $.publisher missing required value",
        "stdout": "",
      }
    `)
  })
})
