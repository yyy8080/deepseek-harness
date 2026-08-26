import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { delimiter, join, resolve } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  anchorPathSpec,
  runPackageManager,
} from '@deepseek-ai/dsh-plugin-install/src/package-manager.ts'
import { cleanupFixtures, fixture } from './fixture.ts'

afterEach(() => {
  vi.unstubAllEnvs()
  cleanupFixtures()
})

describe('anchorPathSpec', () => {
  it('anchors every relative filesystem form against the invoking directory', () => {
    expect(anchorPathSpec('.', '/work')).toBe(resolve('/work'))
    expect(anchorPathSpec('..', '/work/checkout')).toBe(resolve('/work'))
    expect(anchorPathSpec('./plugin', '/work')).toBe(resolve('/work/plugin'))
    expect(anchorPathSpec('../plugin', '/work/checkout')).toBe(resolve('/work/plugin'))
  })

  it('keeps the prefix a caller chose, because pnpm links and copies differently', () => {
    expect(anchorPathSpec('file:./plugin', '/work')).toBe(`file:${resolve('/work/plugin')}`)
    expect(anchorPathSpec('link:../plugin', '/work/checkout')).toBe(`link:${resolve('/work/plugin')}`)
  })

  it('passes through everything that is not a relative path spec', () => {
    for (const argument of ['add', '--save-dev', 'dsh-plugin-sample', '/absolute/plugin.tgz', 'https://x.test/p.tgz']) {
      expect(anchorPathSpec(argument, '/work')).toBe(argument)
    }
  })
})

describe('runPackageManager', () => {
  it('reports an absent package manager with a routable code', () => {
    const { root } = fixture()
    vi.stubEnv('PATH', join(root, 'empty-bin'))

    expect(() => runPackageManager({ cwd: root, args: ['--version'], stdio: 'pipe' }))
      .toThrow(expect.objectContaining({ code: 'PLUGIN_INSTALL_PACKAGE_MANAGER_MISSING' }))
  })

  // A non-executable file named pnpm makes spawn fail with EACCES rather than
  // ENOENT; Windows resolves through a .cmd shim and has no execute bit.
  it.skipIf(process.platform === 'win32')('propagates a spawn failure that is not an absent binary', () => {
    const { root } = fixture()
    const bin = join(root, 'bin')
    mkdirSync(bin, { recursive: true })
    writeFileSync(join(bin, 'pnpm'), '#!/bin/sh\n')
    chmodSync(join(bin, 'pnpm'), 0o644)
    vi.stubEnv('PATH', bin)

    expect(() => runPackageManager({ cwd: root, args: ['--version'], stdio: 'pipe' }))
      .toThrow(expect.objectContaining({ code: 'EACCES' }))
  })

  it('captures the exit code and diagnostics of a real failing run', () => {
    const { root } = fixture()

    const run = runPackageManager({ cwd: root, args: ['run', 'no-such-script'], stdio: 'pipe' })

    expect(run.exitCode).not.toBe(0)
    expect(run.output).not.toBe('')
  })

  it('captures nothing when the caller streams the run to its own console', () => {
    const { root } = fixture()

    expect(runPackageManager({ cwd: root, args: ['--version'], stdio: 'inherit' }))
      .toEqual({ exitCode: 0, output: '' })
  })

  // Windows has no signal delivery; a killed process still reports an exit code there.
  it.skipIf(process.platform === 'win32')('counts a run killed by a signal as a failure', () => {
    const { root } = fixture()
    vi.stubEnv('PATH', `${stubPackageManager(root, "process.kill(process.pid, 'SIGKILL')")}${delimiter}${process.env.PATH ?? ''}`)

    expect(runPackageManager({ cwd: root, args: ['--version'], stdio: 'pipe' }).exitCode).toBe(1)
  })

  it('scrubs the enclosing workspace scope from the child environment', () => {
    const { root } = fixture()
    const reported = join(root, 'environment.txt')
    const bin = stubPackageManager(root, `writeFileSync(${JSON.stringify(reported)}, `
      + 'String(process.env.npm_config_workspace_dir))')
    vi.stubEnv('PATH', `${bin}${delimiter}${process.env.PATH ?? ''}`)
    vi.stubEnv('npm_config_workspace_dir', join(root, 'outer-workspace'))

    expect(runPackageManager({ cwd: root, args: ['--version'], stdio: 'pipe' }).exitCode).toBe(0)

    expect(readFileSync(reported, 'utf8')).toBe('undefined')
  })
})

/**
 * Put a stub `pnpm` on disk that runs one line of Node with `node:fs` imported.
 * @param root - the directory the stub is written under.
 * @param body - the statement the stub executes.
 * @returns the directory to prepend to PATH.
 */
function stubPackageManager(root: string, body: string): string {
  const bin = join(root, 'bin')
  mkdirSync(bin, { recursive: true })
  const runner = join(bin, 'stub.mjs')
  writeFileSync(runner, `import { writeFileSync } from 'node:fs'\n${body}\n`)
  if (process.platform === 'win32') {
    writeFileSync(join(bin, 'pnpm.cmd'), `@node "${runner}" %*\r\n`)
    return bin
  }
  writeFileSync(join(bin, 'pnpm'), `#!/bin/sh\nexec node ${JSON.stringify(runner)} "$@"\n`)
  chmodSync(join(bin, 'pnpm'), 0o755)
  return bin
}
