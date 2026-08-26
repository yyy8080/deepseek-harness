/**
 * Tests for `ctx.subprocess` over a connector: executable resolution, the
 * asynchronously-published handle, each stdio disposition, and the teardown
 * that must not leave a target process running.
 */

import { Buffer } from 'node:buffer'
import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import ConnectorRegistry, { ConnectorId, bindSessionConnector } from '@deepseek-ai/dsh-connector'
import * as ConnectorHost from '@deepseek-ai/dsh-connector-host'
import ConnectorSubprocessRuntime from '@deepseek-ai/dsh-subprocess-connector'
import type { SubprocessHandle } from '@deepseek-ai/dsh-subprocess'

const trash: (() => void)[] = []

afterEach(() => {
  for (const release of trash.splice(0)) release()
})

function workdir(): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'dsh-subprocess-connector-')))
  trash.push(() => { rmSync(dir, { recursive: true, force: true }) })
  return dir
}

async function mounted(dir: string, options: { default?: string } = { default: 'local' }): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(ConnectorRegistry, options)
  await ctx.plugin(ConnectorHost, { id: 'local', workdir: dir })
  await ctx.plugin(ConnectorSubprocessRuntime)
  return ctx
}

/** Read everything one piped stream delivers. */
async function drain(handle: SubprocessHandle, stream: 'stdout' | 'stderr'): Promise<string> {
  const chunks: Buffer[] = []
  for await (const chunk of handle[stream] as AsyncIterable<Buffer>) chunks.push(chunk)
  return Buffer.concat(chunks).toString('utf8')
}

describe('executable resolution', () => {
  it('resolves on the connector', async () => {
    const ctx = await mounted(workdir())

    await expect(ctx.subprocess.resolveExecutable(process.execPath)).resolves.toBe(process.execPath)
  })

  it('refuses an empty command before crossing the link', async () => {
    const ctx = await mounted(workdir())

    await expect(ctx.subprocess.resolveExecutable('')).rejects.toThrow('executable must be non-empty')
  })

  it('raises the connector failure when no connector is resolvable', async () => {
    const ctx = await mounted(workdir(), {})

    await expect(ctx.subprocess.resolveExecutable('node')).rejects.toMatchObject({ code: 'CONNECTOR_UNKNOWN' })
  })
})

describe('spawning', () => {
  it('publishes a handle whose pid appears once the target answers', async () => {
    const dir = workdir()
    const ctx = await mounted(dir)

    const handle = ctx.subprocess.spawn({
      argv: [process.execPath, '-e', 'process.stdout.write("piped")'],
      cwd: dir,
      graceMs: 100,
      stdio: { stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' },
    })

    expect(handle.pid).toBe(-1)
    await expect(drain(handle, 'stdout')).resolves.toBe('piped')
    await expect(handle.done).resolves.toEqual({ exitCode: 0, signal: null })
    expect(handle.pid).toBeGreaterThan(0)
    await expect(handle.waitForExit()).resolves.toBe(true)
  })

  it('pipes each output stream separately', async () => {
    const dir = workdir()
    const ctx = await mounted(dir)

    const handle = ctx.subprocess.spawn({
      argv: [process.execPath, '-e', 'process.stdout.write("out"); process.stderr.write("err")'],
      cwd: dir,
      graceMs: 100,
      stdio: { stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' },
    })

    await expect(Promise.all([drain(handle, 'stdout'), drain(handle, 'stderr')])).resolves.toEqual(['out', 'err'])
  })

  it('collects a bounded tail of each stream instead of piping it', async () => {
    const dir = workdir()
    const ctx = await mounted(dir)

    const handle = ctx.subprocess.spawn({
      argv: [process.execPath, '-e', 'process.stdout.write("out"); process.stderr.write("err")'],
      cwd: dir,
      graceMs: 100,
      stdio: { stdin: 'ignore', stdout: { maxBytes: 1024 }, stderr: { maxBytes: 1024 } },
    })
    await handle.done

    expect(handle.stdout).toBeUndefined()
    expect(handle.collected.stdout?.readFrom(0).text).toBe('out')
    expect(handle.collected.stderr?.readFrom(0).text).toBe('err')
  })

  it('forwards an inherited stream to the harness descriptor', async () => {
    const dir = workdir()
    const ctx = await mounted(dir)
    const written: string[] = []
    const restore = process.stdout.write.bind(process.stdout)
    process.stdout.write = (chunk: string | Uint8Array) => {
      written.push(Buffer.from(chunk).toString('utf8'))
      return true
    }
    trash.push(() => { process.stdout.write = restore })

    const handle = ctx.subprocess.spawn({
      argv: [process.execPath, '-e', 'process.stdout.write("inherited")'],
      cwd: dir,
      graceMs: 100,
      stdio: { stdin: 'ignore', stdout: 'inherit', stderr: 'inherit' },
    })
    await handle.done
    process.stdout.write = restore

    expect(written).toContain('inherited')
    expect(handle.collected).toEqual({})
  })

  it('writes a live stdin pipe and closes it', async () => {
    const dir = workdir()
    const ctx = await mounted(dir)

    const handle = ctx.subprocess.spawn({
      argv: [process.execPath, '-e', 'process.stdin.pipe(process.stdout)'],
      cwd: dir,
      graceMs: 100,
      stdio: { stdin: 'pipe', stdout: 'pipe', stderr: 'pipe' },
    })
    handle.stdin?.write('through the link')
    handle.stdin?.end()

    await expect(drain(handle, 'stdout')).resolves.toBe('through the link')
  })

  it('sends a pre-filled stdin with the spawn', async () => {
    const dir = workdir()
    const ctx = await mounted(dir)

    const handle = ctx.subprocess.spawn({
      argv: [process.execPath, '-e', 'process.stdin.pipe(process.stdout)'],
      cwd: dir,
      graceMs: 100,
      stdio: { stdin: { data: 'prefilled' }, stdout: 'pipe', stderr: 'pipe' },
    })

    expect(handle.stdin).toBeUndefined()
    await expect(drain(handle, 'stdout')).resolves.toBe('prefilled')
  })

  it('passes explicit environment entries and drops tombstoned ones', async () => {
    const dir = workdir()
    const ctx = await mounted(dir)

    const handle = ctx.subprocess.spawn({
      argv: [process.execPath, '-e', 'process.stdout.write(`${process.env.KEEP}/${process.env.DROP ?? "-"}`)'],
      cwd: dir,
      graceMs: 100,
      stdio: { stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' },
      env: { KEEP: 'kept', DROP: undefined },
    })

    await expect(drain(handle, 'stdout')).resolves.toBe('kept/-')
  })

  it('terminates the target process when the caller aborts', async () => {
    const dir = workdir()
    const ctx = await mounted(dir)
    const controller = new AbortController()

    const handle = ctx.subprocess.spawn({
      argv: [process.execPath, '-e', 'setInterval(() => {}, 1000)'],
      cwd: dir,
      graceMs: 50,
      stdio: { stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' },
      signal: controller.signal,
    })
    controller.abort()

    await expect(handle.done).resolves.toMatchObject({ exitCode: null })
  })

  it('terminates immediately for a signal that already fired', async () => {
    const dir = workdir()
    const ctx = await mounted(dir)
    const controller = new AbortController()
    controller.abort()

    const handle = ctx.subprocess.spawn({
      argv: [process.execPath, '-e', 'setInterval(() => {}, 1000)'],
      cwd: dir,
      graceMs: 50,
      stdio: { stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' },
      signal: controller.signal,
    })

    await expect(handle.done).resolves.toMatchObject({ exitCode: null })
  })

  it('reports a target spawn failure through the published handle', async () => {
    const dir = workdir()
    const ctx = await mounted(dir)

    const handle = ctx.subprocess.spawn({
      argv: [join(dir, 'not-an-executable')],
      cwd: dir,
      graceMs: 50,
      stdio: { stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' },
    })

    await expect(handle.done).rejects.toMatchObject({ code: 'CONNECTOR_UNAVAILABLE' })
    await expect(handle.waitForExit()).resolves.toBe(true)
  })

  it('reports an unopenable link through the published handle', async () => {
    const dir = workdir()
    const ctx = await mounted(dir, {})

    const handle = ctx.subprocess.spawn({
      argv: [process.execPath, '-e', ''],
      cwd: dir,
      graceMs: 50,
      stdio: { stdin: 'pipe', stdout: 'pipe', stderr: 'pipe' },
    })

    await expect(handle.done).rejects.toMatchObject({ code: 'CONNECTOR_UNKNOWN' })
    await expect(new Promise((_resolve, reject) => {
      handle.stdin?.on('error', reject)
      handle.stdin?.write('x')
    })).rejects.toMatchObject({ code: 'CONNECTOR_UNKNOWN' })
    expect(() => { handle.terminate() }).not.toThrow()
  })

  it('fails a stdin close that the unreachable connector can never accept', async () => {
    const dir = workdir()
    const ctx = await mounted(dir, {})

    const handle = ctx.subprocess.spawn({
      argv: [process.execPath, '-e', ''],
      cwd: dir,
      graceMs: 50,
      stdio: { stdin: 'pipe', stdout: 'pipe', stderr: 'pipe' },
    })
    await expect(handle.done).rejects.toThrow()

    await expect(new Promise((_resolve, reject) => {
      handle.stdin?.on('error', reject)
      handle.stdin?.end()
    })).rejects.toMatchObject({ code: 'CONNECTOR_UNKNOWN' })
  })

  it('abandons a wait for the tree once the caller aborts it', async () => {
    const dir = workdir()
    const ctx = await mounted(dir)
    const controller = new AbortController()

    const handle = ctx.subprocess.spawn({
      argv: [process.execPath, '-e', 'setInterval(() => {}, 1000)'],
      cwd: dir,
      graceMs: 50,
      stdio: { stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' },
    })
    const waiting = handle.waitForExit(controller.signal)
    controller.abort()

    await expect(waiting).resolves.toBe(false)
    await expect(handle.waitForExit(controller.signal)).resolves.toBe(false)
    handle.terminate()
    await handle.done
  })
})

describe('unsupported capabilities', () => {
  it('refuses to allocate a terminal on a connector link', async () => {
    const dir = workdir()
    const ctx = await mounted(dir)

    await expect(ctx.subprocess.spawnTerminal({ argv: [process.execPath], cwd: dir, graceMs: 50, rows: 24, cols: 80 }))
      .rejects.toMatchObject({ code: 'CONNECTOR_UNSUPPORTED' })
  })
})

describe('session selection', () => {
  it('runs each session on the connector it bound', async () => {
    const dir = workdir()
    const ctx = new Context()
    await ctx.plugin(AgentRegistry)
    await ctx.plugin(ConnectorRegistry, { default: 'here' })
    await ctx.plugin(ConnectorHost, { id: 'here', workdir: dir })
    await ctx.plugin(ConnectorSubprocessRuntime)
    ctx.connectors.register(
      { id: ConnectorId('offline'), os: 'linux', workdir: '/srv/work' },
      async () => { throw new Error('connection refused') },
    )
    const bound = Session.create(SessionId('bound'), undefined, { version: 0, id: SessionId('bound'), createdAt: 0 })
    bindSessionConnector(bound, ConnectorId('offline'))

    await expect(ctx.subprocess.resolveExecutable(process.execPath)).resolves.toBe(process.execPath)
    await expect(ctx.agents.withInitiator(
      { session: bound } as unknown as Agent,
      async () => ctx.subprocess.resolveExecutable(process.execPath),
    )).rejects.toMatchObject({ code: 'CONNECTOR_UNAVAILABLE' })
  })
})

describe('teardown', () => {
  it('terminates every target process the harness still owns', async () => {
    const dir = workdir()
    const ctx = new Context()
    await ctx.plugin(ConnectorRegistry, { default: 'local' })
    await ctx.plugin(ConnectorHost, { id: 'local', workdir: dir })
    const fiber = await ctx.plugin(ConnectorSubprocessRuntime)
    const running = ctx.subprocess.spawn({
      argv: [process.execPath, '-e', 'setInterval(() => {}, 1000)'],
      cwd: dir,
      graceMs: 50,
      stdio: { stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' },
    })
    const doomed = ctx.subprocess.spawn({
      argv: [join(dir, 'not-an-executable')],
      cwd: dir,
      graceMs: 50,
      stdio: { stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' },
    })
    void doomed.done.catch(() => undefined)
    await new Promise<void>((resolve) => { setTimeout(resolve, 50) })

    await fiber.dispose()

    await expect(running.done).resolves.toMatchObject({ exitCode: null })
  })
})
