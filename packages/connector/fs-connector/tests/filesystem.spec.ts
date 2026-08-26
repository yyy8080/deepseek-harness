/**
 * Tests for `ctx.fs` over a connector: the provider's target-dialect path
 * computations, its forwarding of every remote operation, and the session
 * binding that decides which machine answers.
 */

import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import { FsTargetKey } from '@deepseek-ai/dsh-fs'
import type { FsTarget } from '@deepseek-ai/dsh-fs'
import ConnectorRegistry, { ConnectorId, bindSessionConnector } from '@deepseek-ai/dsh-connector'
import type { ConnectorOs } from '@deepseek-ai/dsh-connector'
import * as ConnectorHost from '@deepseek-ai/dsh-connector-host'
import ConnectorFileSystem, { connectorFileUrl } from '@deepseek-ai/dsh-fs-connector'

const trash: (() => void)[] = []

afterEach(() => {
  for (const release of trash.splice(0)) release()
})

function workdir(): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'dsh-fs-connector-')))
  trash.push(() => { rmSync(dir, { recursive: true, force: true }) })
  return dir
}

/** A harness whose filesystem seam is served by an in-process local connector. */
async function mounted(dir: string, options: { default?: string } = { default: 'local' }): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(ConnectorRegistry, options)
  await ctx.plugin(ConnectorHost, { id: 'local', workdir: dir })
  await ctx.plugin(ConnectorFileSystem)
  return ctx
}

function target(path: string): FsTarget {
  return { targetKey: FsTargetKey(path), displayPath: path }
}

describe('target-dialect path computation', () => {
  it.each([
    ['linux', '/srv/work/notes.txt', 'file:///srv/work/notes.txt'],
    ['macos', '/Users/build/a b', 'file:///Users/build/a b'],
    ['windows', String.raw`C:\work\notes.txt`, 'file:///C:/work/notes.txt'],
    ['windows', String.raw`\\share\team\notes.txt`, 'file://share/team/notes.txt'],
  ] as [ConnectorOs, string, string][])('renders a %s path as %s', (os, path, url) => {
    expect(connectorFileUrl(os, path)).toBe(url)
  })

  it('escapes the characters a file URI cannot carry literally', () => {
    expect(connectorFileUrl('linux', '/srv/100%/a?b#c')).toBe('file:///srv/100%25/a%3Fb%23c')
    expect(connectorFileUrl('linux', '/srv/a\nb\rc\td')).toBe('file:///srv/a%0Ab%0Dc%09d')
  })

  it('computes the file URI in the connector dialect, not the host one', async () => {
    const ctx = await mounted(workdir())

    expect(ctx.fs.fileUrl(target('/srv/work/notes.txt'))).toBe('file:///srv/work/notes.txt')
    expect(ctx.fs.processPath(target('/srv/work/notes.txt'))).toBe('/srv/work/notes.txt')
  })

  it('answers containment in the connector dialect', async () => {
    const ctx = await mounted(workdir())

    expect(ctx.fs.contains(target('/srv/work'), target('/srv/work'))).toBe(true)
    expect(ctx.fs.contains(target('/srv/work'), target('/srv/work/sub/notes.txt'))).toBe(true)
    expect(ctx.fs.contains(target('/srv/work'), target('/srv/other'))).toBe(false)
    expect(ctx.fs.contains(target('/srv/work'), target('/srv'))).toBe(false)
  })
})

describe('forwarding to the bound connector', () => {
  it('resolves relative paths in the connector workdir', async () => {
    const dir = workdir()
    const ctx = await mounted(dir)

    await expect(ctx.fs.resolve('notes.txt')).resolves.toEqual(target(join(dir, 'notes.txt')))
  })

  it('rejects an empty path and an aborted resolve before crossing the link', async () => {
    const ctx = await mounted(workdir())
    const controller = new AbortController()
    controller.abort()

    await expect(ctx.fs.resolve('   ')).rejects.toMatchObject({ code: 'FS_NOT_FOUND' })
    await expect(ctx.fs.resolve('notes.txt', { signal: controller.signal }))
      .rejects.toMatchObject({ code: 'FS_ABORTED' })
    await expect(ctx.fs.lstat('  ')).rejects.toMatchObject({ code: 'FS_NOT_FOUND' })
  })

  it('writes, reads, streams, lists, and edits on the connector', async () => {
    const dir = workdir()
    const ctx = await mounted(dir)
    const notes = await ctx.fs.resolve('notes.txt')

    const written = await ctx.fs.writeText(notes, 'hello\n', { kind: 'createIfAbsent' })
    await expect(ctx.fs.readText(notes)).resolves.toBe('hello\n')
    await expect(Array.fromAsync(await ctx.fs.streamText(notes))).resolves.toEqual(['hello\n'])
    await expect(ctx.fs.readBytes(notes, undefined, 64)).resolves.toEqual(new TextEncoder().encode('hello\n'))
    await expect(ctx.fs.stat(notes)).resolves.toMatchObject({ type: 'file' })
    await expect(ctx.fs.lstat('notes.txt', { cwd: dir })).resolves.toMatchObject({ type: 'file' })
    await expect(ctx.fs.listDir(await ctx.fs.resolve('.'))).resolves.toMatchObject([{ name: 'notes.txt' }])
    await expect(ctx.fs.editText(
      notes,
      { oldString: 'hello', newString: 'bye', replaceAll: false },
      { version: written.version },
    )).resolves.toMatchObject({ after: 'bye\n' })
  })

  it('streams nothing for an empty file', async () => {
    const dir = workdir()
    const ctx = await mounted(dir)
    writeFileSync(join(dir, 'empty.txt'), '')

    await expect(Array.fromAsync(await ctx.fs.streamText(await ctx.fs.resolve('empty.txt')))).resolves.toEqual([])
  })

  it('forwards an unconditional write and edit without a guard', async () => {
    const dir = workdir()
    const ctx = await mounted(dir)
    const notes = await ctx.fs.resolve('notes.txt')
    await ctx.fs.writeText(notes, 'one\n')

    await expect(ctx.fs.writeText(notes, 'two\n')).resolves.toMatchObject({ operation: 'update' })
    await expect(ctx.fs.editText(notes, { oldString: 'two', newString: 'three', replaceAll: false }))
      .resolves.toMatchObject({ after: 'three\n' })
  })

  it('raises the connector failure when no connector is resolvable', async () => {
    const ctx = await mounted(workdir(), {})

    await expect(ctx.fs.resolve('notes.txt')).rejects.toMatchObject({ code: 'CONNECTOR_UNKNOWN' })
    expect(() => ctx.fs.fileUrl(target('/srv/notes.txt'))).toThrow(/no connector is bound/)
  })
})

describe('session selection', () => {
  it('routes each session to the connector it bound', async () => {
    const first = workdir()
    const second = workdir()
    const ctx = new Context()
    await ctx.plugin(AgentRegistry)
    await ctx.plugin(ConnectorRegistry, { default: 'first' })
    await ctx.plugin(ConnectorHost, { id: 'first', workdir: first })
    await ctx.plugin(ConnectorHost, { id: 'second', workdir: second })
    await ctx.plugin(ConnectorFileSystem)
    const bound = Session.create(SessionId('bound'), undefined, { version: 0, id: SessionId('bound'), createdAt: 0 })
    bindSessionConnector(bound, ConnectorId('second'))

    await expect(ctx.fs.resolve('notes.txt')).resolves.toEqual(target(join(first, 'notes.txt')))
    await expect(ctx.agents.withInitiator({ session: bound } as unknown as Agent, async () => ctx.fs.resolve('notes.txt')))
      .resolves.toEqual(target(join(second, 'notes.txt')))
  })
})
