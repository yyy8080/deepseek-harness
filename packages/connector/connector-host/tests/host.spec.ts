/**
 * Tests for the target-side execution world: the connector operation set
 * projected onto the shipped local filesystem and subprocess providers.
 */

import { Buffer } from 'node:buffer'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { ConnectorLink, ConnectorProcessEvents } from '@deepseek-ai/dsh-connector'
import { createConnectorHost, hostConnectorOs } from '@deepseek-ai/dsh-connector-host'

const trash: (() => void)[] = []

afterEach(() => {
  for (const release of trash.splice(0)) release()
})

function workdir(): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'dsh-connector-host-')))
  trash.push(() => { rmSync(dir, { recursive: true, force: true }) })
  return dir
}

async function host(dir: string): Promise<ConnectorLink> {
  const link = await createConnectorHost({ workdir: dir })
  trash.push(() => { void link.close() })
  return link
}

/** Collect every notification one spawn produces, in delivery order. */
function recorder(): { events: ConnectorProcessEvents; stdout: () => string; done: Promise<void> } {
  const chunks: Buffer[] = []
  let settle!: () => void
  const done = new Promise<void>((resolve) => { settle = resolve })
  return {
    events: {
      data: (stream, base64) => { if (stream === 'stdout') chunks.push(Buffer.from(base64, 'base64')) },
      exit: () => {},
      failed: () => { settle() },
      gone: () => { settle() },
    },
    stdout: () => Buffer.concat(chunks).toString('utf8'),
    done,
  }
}

describe('host identity', () => {
  it('reports this machine and the served working directory', async () => {
    const dir = workdir()
    const link = await host(dir)

    expect(link.descriptor).toEqual({ id: 'host', os: hostConnectorOs(), workdir: dir })
  })

  it.each([
    ['win32', 'windows'],
    ['darwin', 'macos'],
    ['linux', 'linux'],
    ['freebsd', 'linux'],
  ] as const)('classifies %s as the %s connector family', (platform, family) => {
    expect(hostConnectorOs(platform)).toBe(family)
  })

  it('classifies this process without an explicit platform', () => {
    expect(hostConnectorOs()).toBe(hostConnectorOs(process.platform))
  })

  it('closes its private application exactly once', async () => {
    const link = await createConnectorHost({ id: 'named', workdir: workdir() })

    expect(link.descriptor.id).toBe('named')
    await link.close()
    await expect(link.close()).resolves.toBeUndefined()
  })
})

describe('host filesystem operations', () => {
  it('resolves relative paths against the served workdir', async () => {
    const dir = workdir()
    const link = await host(dir)

    await expect(link.files.resolve('notes.txt', undefined, undefined))
      .resolves.toEqual({ targetKey: join(dir, 'notes.txt'), displayPath: join(dir, 'notes.txt') })
  })

  it('resolves relative paths against an explicit cwd', async () => {
    const dir = workdir()
    const link = await host(dir)

    await expect(link.files.resolve('notes.txt', join(dir, 'sub'), undefined))
      .resolves.toMatchObject({ targetKey: join(dir, 'sub', 'notes.txt') })
  })

  it('writes, reads, lists, and edits through the local provider', async () => {
    const dir = workdir()
    const link = await host(dir)
    const target = await link.files.resolve('notes.txt', undefined, undefined)

    const written = await link.files.writeText({ ...target, content: 'hello\n' }, undefined)
    expect(written.version).toBeTypeOf('string')
    await expect(link.files.readText(target.targetKey, target.displayPath, undefined)).resolves.toBe('hello\n')
    await expect(link.files.readBytesBase64(target.targetKey, target.displayPath, 1024, undefined))
      .resolves.toBe(Buffer.from('hello\n').toString('base64'))

    const edited = await link.files.editText(
      {
        ...target,
        edit: { oldString: 'hello', newString: 'goodbye', replaceAll: false },
        expected: { version: written.version },
      },
      undefined,
    )
    expect(edited.version).not.toBe(written.version)
    await expect(link.files.readText(target.targetKey, target.displayPath, undefined)).resolves.toBe('goodbye\n')

    const dirTarget = await link.files.resolve('.', undefined, undefined)
    await expect(link.files.listDir(dirTarget.targetKey, dirTarget.displayPath, undefined))
      .resolves.toMatchObject([{ name: 'notes.txt', type: 'file' }])
  })

  it('reports metadata for present and absent targets', async () => {
    const dir = workdir()
    const link = await host(dir)
    writeFileSync(join(dir, 'notes.txt'), 'hi')

    await expect(link.files.stat(join(dir, 'notes.txt'), undefined)).resolves.toMatchObject({ type: 'file' })
    await expect(link.files.stat(join(dir, 'absent.txt'), undefined)).resolves.toBeUndefined()
    await expect(link.files.lstat('notes.txt', dir, undefined)).resolves.toMatchObject({ type: 'file' })
    await expect(link.files.lstat('absent.txt', dir, undefined)).resolves.toBeUndefined()
    await expect(link.files.lstat(join(dir, 'notes.txt'), undefined, undefined)).resolves.toMatchObject({ type: 'file' })
  })

  it('projects file and directory entries onto JSON-encodable wire fields', async () => {
    const dir = workdir()
    const link = await host(dir)
    writeFileSync(join(dir, 'notes.txt'), 'hi')
    mkdirSync(join(dir, 'nested'))
    symlinkSync(join(dir, 'absent.txt'), join(dir, 'dangling'))
    const dirTarget = await link.files.resolve('.', undefined, undefined)

    const entries = await link.files.listDir(dirTarget.targetKey, dirTarget.displayPath, undefined)

    expect(entries.map(entry => [entry.name, entry.type, 'version' in entry, 'size' in entry])).toEqual([
      ['dangling', 'other', false, false],
      ['nested', 'directory', true, false],
      ['notes.txt', 'file', true, true],
    ])
    expect(JSON.parse(JSON.stringify(entries))).toEqual(entries)
  })

  it('carries the caller cancellation signal into every read operation', async () => {
    const dir = workdir()
    const link = await host(dir)
    writeFileSync(join(dir, 'notes.txt'), 'hi')
    const signal = new AbortController().signal

    const target = await link.files.resolve('notes.txt', dir, signal)
    await expect(link.files.stat(target.targetKey, signal)).resolves.toMatchObject({ type: 'file' })
    await expect(link.files.lstat('notes.txt', dir, signal)).resolves.toMatchObject({ type: 'file' })
    await expect(link.files.readText(target.targetKey, target.displayPath, signal)).resolves.toBe('hi')
    await expect(link.files.readBytesBase64(target.targetKey, target.displayPath, 8, signal)).resolves.toBe('aGk=')
    await expect(link.files.listDir(dir, dir, signal)).resolves.toHaveLength(1)
    const written = await link.files.writeText({ ...target, content: 'bye' }, signal)
    await expect(link.files.editText(
      { ...target, edit: { oldString: 'bye', newString: 'hi', replaceAll: true }, expected: { version: written.version } },
      signal,
    )).resolves.toMatchObject({ after: 'hi' })
  })

  it('aborts a read whose signal already fired', async () => {
    const dir = workdir()
    const link = await host(dir)
    const controller = new AbortController()
    controller.abort()

    await expect(link.files.resolve('notes.txt', dir, controller.signal)).rejects.toMatchObject({ code: 'FS_ABORTED' })
  })
})

describe('host process operations', () => {
  it('resolves an executable on the target PATH', async () => {
    const link = await host(workdir())

    await expect(link.processes.resolveExecutable(process.execPath, undefined, undefined))
      .resolves.toBe(process.execPath)
  })

  it('runs a process and delivers its output and exit before its tree-exit', async () => {
    const dir = workdir()
    const link = await host(dir)
    const observer = recorder()
    const order: string[] = []
    const handle = await link.processes.spawn(
      { argv: [process.execPath, '-e', 'process.stdout.write("out")'], cwd: dir, stdin: 'ignore', graceMs: 100 },
      {
        ...observer.events,
        data: (stream, base64) => { observer.events.data(stream, base64); order.push('data') },
        exit: () => { order.push('exit') },
        gone: () => { order.push('gone'); observer.events.gone() },
      },
    )

    await observer.done

    expect(handle.pid).toBeGreaterThan(0)
    expect(observer.stdout()).toBe('out')
    expect(order).toEqual(['data', 'exit', 'gone'])
  })

  it('delivers each output stream under its own name', async () => {
    const dir = workdir()
    const link = await host(dir)
    const seen: string[] = []
    let settle!: () => void
    const done = new Promise<void>((resolve) => { settle = resolve })
    await link.processes.spawn(
      {
        argv: [process.execPath, '-e', 'process.stdout.write("o"); process.stderr.write("e")'],
        cwd: dir,
        stdin: 'ignore',
        graceMs: 100,
      },
      {
        data: (stream, base64) => { seen.push(`${stream}:${Buffer.from(base64, 'base64').toString('utf8')}`) },
        exit: () => {},
        failed: () => { settle() },
        gone: () => { settle() },
      },
    )

    await done

    expect(seen.toSorted()).toEqual(['stderr:e', 'stdout:o'])
  })

  it('feeds a pre-filled stdin and echoes it back', async () => {
    const dir = workdir()
    const link = await host(dir)
    const observer = recorder()
    await link.processes.spawn(
      {
        argv: [process.execPath, '-e', 'process.stdin.pipe(process.stdout)'],
        cwd: dir,
        stdin: { base64: Buffer.from('piped', 'utf8').toString('base64') },
        graceMs: 100,
      },
      observer.events,
    )

    await observer.done

    expect(observer.stdout()).toBe('piped')
  })

  it('accepts live stdin writes and a close', async () => {
    const dir = workdir()
    const link = await host(dir)
    const observer = recorder()
    const handle = await link.processes.spawn(
      { argv: [process.execPath, '-e', 'process.stdin.pipe(process.stdout)'], cwd: dir, stdin: 'pipe', graceMs: 100 },
      observer.events,
    )

    await handle.write(Buffer.from('live', 'utf8').toString('base64'))
    await handle.closeStdin()
    await handle.closeStdin()
    await observer.done

    expect(observer.stdout()).toBe('live')
  })

  it('refuses a stdin write to a process that has none', async () => {
    const dir = workdir()
    const link = await host(dir)
    const observer = recorder()
    const handle = await link.processes.spawn(
      { argv: [process.execPath, '-e', ''], cwd: dir, stdin: 'ignore', graceMs: 100 },
      observer.events,
    )

    expect(() => handle.write('')).toThrow(/was not spawned with a stdin pipe/)
    await observer.done
  })

  it('reports a stdin write failure from the closed stream', async () => {
    const dir = workdir()
    const link = await host(dir)
    const observer = recorder()
    const handle = await link.processes.spawn(
      { argv: [process.execPath, '-e', ''], cwd: dir, stdin: 'pipe', graceMs: 100 },
      observer.events,
    )
    await handle.closeStdin()

    await expect(handle.write('AA==')).rejects.toThrow()
    await observer.done
  })

  it('terminates a process that would otherwise outlive the call', async () => {
    const dir = workdir()
    const link = await host(dir)
    const observer = recorder()
    const handle = await link.processes.spawn(
      { argv: [process.execPath, '-e', 'setInterval(() => {}, 1000)'], cwd: dir, stdin: 'ignore', graceMs: 50 },
      observer.events,
    )

    await handle.terminate()
    await observer.done

    expect(observer.stdout()).toBe('')
  })

  it('passes explicit environment entries to the target process', async () => {
    const dir = workdir()
    const link = await host(dir)
    const observer = recorder()
    await link.processes.spawn(
      {
        argv: [process.execPath, '-e', 'process.stdout.write(process.env.DSH_PROBE ?? "")'],
        cwd: dir,
        stdin: 'ignore',
        graceMs: 100,
        env: { DSH_PROBE: 'set' },
      },
      observer.events,
    )

    await observer.done

    expect(observer.stdout()).toBe('set')
  })

  it('reports a spawn that never started as a failure', async () => {
    const dir = workdir()
    const link = await host(dir)
    const failed: string[] = []
    let settle!: () => void
    const done = new Promise<void>((resolve) => { settle = resolve })
    await link.processes.spawn(
      { argv: [join(dir, 'not-an-executable')], cwd: dir, stdin: 'ignore', graceMs: 50 },
      {
        data: () => {},
        exit: () => {},
        failed: (message) => { failed.push(message); settle() },
        gone: () => {},
      },
    )

    await done

    expect(failed).toHaveLength(1)
  })
})
