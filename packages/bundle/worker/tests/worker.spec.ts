import { mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import * as Worker from '@deepseek-ai/dsh-worker'
import { Config } from '@deepseek-ai/dsh-worker'

let root: string
let ctx: Context

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'dsh-worker-'))
  ctx = new Context()
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

/** Stand in for the bound HTTP server the bundle publishes the origin of. */
function serveOn(port: number | undefined): void {
  ctx.provide('webServer', { port } as never)
}

/** Stand in for the Loader whose settlement gates the handshake. */
function loader(settled: Promise<void>): void {
  ctx.provide('loader', { await: () => settled } as never)
}

/** Collect the prompt sections the bundle contributes. */
function collectPrompt(): string[] {
  const sections: string[] = []
  ctx.provide('systemPrompt', {
    section: (entry: { text: () => string }) => { sections.push(entry.text()) },
  } as never)
  return sections
}

/** The handshake path a supervised worker writes. */
function endpointFile(): string {
  return join(root, 'nested', 'endpoint.json')
}

describe('worker bundle readiness', () => {
  it('publishes the bound origin into the handshake file once the tree settles', async () => {
    let settle = (): void => {}
    loader(new Promise<void>((resolve) => { settle = resolve }))
    serveOn(41234)
    const file = endpointFile()

    await ctx.plugin(Worker, Config({ endpointFile: file }))
    await expect(stat(file)).rejects.toThrow()
    settle()

    await vi.waitFor(async () => {
      expect(JSON.parse(await readFile(file, 'utf8'))).toEqual({ origin: 'http://127.0.0.1:41234' })
    })
    expect((await stat(file)).mode & 0o777).toBe(0o600)
  })

  it('publishes immediately when no Loader owns the tree', async () => {
    serveOn(41235)
    const file = endpointFile()

    await ctx.plugin(Worker, Config({ endpointFile: file }))

    await vi.waitFor(async () => {
      expect(JSON.parse(await readFile(file, 'utf8'))).toEqual({ origin: 'http://127.0.0.1:41235' })
    })
  })

  it('prints the origin when no supervisor asked for a handshake', async () => {
    const printed = vi.spyOn(console, 'log').mockImplementation(() => {})
    serveOn(41236)

    await ctx.plugin(Worker, Config({}))

    await vi.waitFor(() => { expect(printed).toHaveBeenCalledWith('dsh worker: http://127.0.0.1:41236') })
    printed.mockRestore()
  })

  it('reports a handshake it could not write instead of exiting silently', async () => {
    const reported = vi.spyOn(console, 'error').mockImplementation(() => {})
    serveOn(undefined)

    await ctx.plugin(Worker, Config({ endpointFile: endpointFile() }))

    await vi.waitFor(() => {
      expect(reported).toHaveBeenCalledWith(expect.stringContaining('could not publish the worker origin'))
    })
    reported.mockRestore()
  })

  it('stays quiet when the tree is torn down before it settles', async () => {
    const printed = vi.spyOn(console, 'log').mockImplementation(() => {})
    let settle = (): void => {}
    loader(new Promise<void>((resolve) => { settle = resolve }))
    const server = ctx.plugin({
      name: 'worker-test-server',
      apply: (child: Context) => { child.provide('webServer', { port: 41237 } as never) },
    })
    await server

    await ctx.plugin(Worker, Config({}))
    await server.dispose()
    settle()
    await new Promise<void>((done) => { setTimeout(done, 20) })

    expect(printed).not.toHaveBeenCalled()
    printed.mockRestore()
  })

  it('stays quiet when the tree failed to boot', async () => {
    const printed = vi.spyOn(console, 'log').mockImplementation(() => {})
    loader(Promise.reject(new Error('boot failed')))
    serveOn(41238)

    await ctx.plugin(Worker, Config({}))
    await new Promise<void>((done) => { setTimeout(done, 20) })

    expect(printed).not.toHaveBeenCalled()
    printed.mockRestore()
  })
})

describe('worker bundle isolation notice', () => {
  it('tells the model its runtime is private to this conversation', async () => {
    const sections = collectPrompt()
    serveOn(41239)

    await ctx.plugin(Worker, Config({}))

    expect(sections).toHaveLength(1)
    expect(sections[0]).toMatch(/isolated DeepSeek Harness runtime/)
  })

  it('omits the notice when a deployment turns it off', async () => {
    const sections = collectPrompt()
    serveOn(41240)

    await ctx.plugin(Worker, Config({ surfaceContext: false }))

    expect(sections).toEqual([])
  })
})
