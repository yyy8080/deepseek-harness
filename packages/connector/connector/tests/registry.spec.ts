/**
 * Tests for the connector registry: registration and its disposer, the
 * session-versus-default resolution order, memoized link opening, and the
 * system-prompt context describing the target machine.
 */

import { posix, win32 } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ConnectorRegistry, {
  ConnectorId,
  bindSessionConnector,
  connectorPathModule,
} from '@deepseek-ai/dsh-connector'
import type { ConnectorDescriptor, ConnectorLink, ConnectorOs } from '@deepseek-ai/dsh-connector'

function descriptor(id: string, os: ConnectorOs = 'linux', workdir = '/srv/work'): ConnectorDescriptor {
  return { id: ConnectorId(id), os, workdir }
}

function stubLink(of: ConnectorDescriptor, close: () => void = () => {}): ConnectorLink {
  return {
    descriptor: of,
    files: {} as ConnectorLink['files'],
    processes: {} as ConnectorLink['processes'],
    close: async () => { close() },
  }
}

async function mounted(config: { default?: string } = {}): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(ConnectorRegistry, config)
  return ctx
}

function session(id: string): Session {
  const sessionId = SessionId(id)
  return Session.create(sessionId, undefined, { version: 0, id: sessionId, createdAt: 0 })
}

describe('registration', () => {
  it('lists registered connectors in registration order', async () => {
    const ctx = await mounted()
    const first = descriptor('build-linux')
    const second = descriptor('lab-windows', 'windows', String.raw`C:\work`)
    ctx.connectors.register(first, async () => stubLink(first))
    ctx.connectors.register(second, async () => stubLink(second))

    expect(ctx.connectors.list()).toEqual([first, second])
    expect(ctx.connectors.get(ConnectorId('lab-windows'))).toEqual(second)
    expect(ctx.connectors.get(ConnectorId('absent'))).toBeUndefined()
  })

  it('refuses a duplicate id rather than resolving sessions to one of two machines', async () => {
    const ctx = await mounted()
    const first = descriptor('build-linux')
    ctx.connectors.register(first, async () => stubLink(first))

    expect(() => ctx.connectors.register(descriptor('build-linux', 'windows'), async () => stubLink(first)))
      .toThrow('connector "build-linux" is already registered')
  })

  it('removes the registration and closes its link when the disposer runs', async () => {
    const ctx = await mounted({ default: 'build-linux' })
    const only = descriptor('build-linux')
    const closed = vi.fn()
    const dispose = ctx.connectors.register(only, async () => stubLink(only, closed))
    await ctx.connectors.link()

    await dispose()

    expect(ctx.connectors.list()).toEqual([])
    expect(closed).toHaveBeenCalledTimes(1)
  })

  it('leaves a replacement registration alone when a stale disposer runs twice', async () => {
    const ctx = await mounted()
    const only = descriptor('build-linux')
    const dispose = ctx.connectors.register(only, async () => stubLink(only))
    await dispose()
    const replacement = descriptor('build-linux', 'macos')
    ctx.connectors.register(replacement, async () => stubLink(replacement))
    await dispose()

    expect(ctx.connectors.list()).toEqual([replacement])
  })
})

describe('resolution', () => {
  it('fails loud when nothing selects a connector', async () => {
    const ctx = await mounted()

    expect(() => ctx.connectors.resolveId()).toThrow(/no connector is bound to this session/)
    expect(ctx.connectors.tryDescribe()).toBeUndefined()
  })

  it('uses the deployment default when the session bound none', async () => {
    const ctx = await mounted({ default: 'build-linux' })
    const only = descriptor('build-linux')
    ctx.connectors.register(only, async () => stubLink(only))

    expect(ctx.connectors.resolveId({ session: session('fresh') })).toBe('build-linux')
    expect(ctx.connectors.describe()).toEqual(only)
  })

  it('lets the session binding outrank the deployment default', async () => {
    const ctx = await mounted({ default: 'build-linux' })
    const fallback = descriptor('build-linux')
    const bound = descriptor('lab-windows', 'windows', String.raw`C:\work`)
    ctx.connectors.register(fallback, async () => stubLink(fallback))
    ctx.connectors.register(bound, async () => stubLink(bound))
    const active = session('bound')
    bindSessionConnector(active, ConnectorId('lab-windows'))

    expect(ctx.connectors.describe({ session: active })).toEqual(bound)
  })

  it('fails loud when the resolved id names no registration', async () => {
    const ctx = await mounted({ default: 'missing' })

    expect(() => ctx.connectors.describe()).toThrow('connector "missing" is not registered')
    expect(ctx.connectors.tryDescribe()).toBeUndefined()
  })

  it('exposes the configured default id', async () => {
    expect((await mounted({ default: 'build-linux' })).connectors.defaultId).toBe('build-linux')
    expect((await mounted()).connectors.defaultId).toBeUndefined()
  })
})

describe('links', () => {
  it('opens one link per connector and reuses it', async () => {
    const ctx = await mounted({ default: 'build-linux' })
    const only = descriptor('build-linux')
    const open = vi.fn(async () => stubLink(only))
    ctx.connectors.register(only, open)
    const opened = vi.fn()
    ctx.on('connector/link-opened', opened)

    const [first, second] = await Promise.all([ctx.connectors.link(), ctx.connectors.link()])

    expect(first).toBe(second)
    expect(open).toHaveBeenCalledTimes(1)
    expect(opened).toHaveBeenCalledWith(only)
  })

  it('reports a failed opening as an unavailable connector and retries next time', async () => {
    const ctx = await mounted({ default: 'build-linux' })
    const only = descriptor('build-linux')
    const open = vi.fn()
      .mockRejectedValueOnce(new Error('connection refused'))
      .mockImplementation(async () => stubLink(only))
    ctx.connectors.register(only, open as () => Promise<ConnectorLink>)

    await expect(ctx.connectors.link()).rejects.toMatchObject({ code: 'CONNECTOR_UNAVAILABLE' })
    await expect(ctx.connectors.link()).resolves.toMatchObject({ descriptor: only })
    expect(open).toHaveBeenCalledTimes(2)
  })

  it('closes every open link and announces it when the registry unloads', async () => {
    const ctx = new Context()
    const fiber = await ctx.plugin(ConnectorRegistry, { default: 'build-linux' })
    const only = descriptor('build-linux')
    const closed = vi.fn()
    ctx.connectors.register(only, async () => stubLink(only, closed))
    const announced = vi.fn()
    ctx.on('connector/link-closed', announced)
    await ctx.connectors.link()

    await fiber.dispose()

    expect(closed).toHaveBeenCalledTimes(1)
    expect(announced).toHaveBeenCalledWith(only)
  })

  it('waits for an in-flight opening that fails instead of closing a link it never got', async () => {
    const ctx = new Context()
    const fiber = await ctx.plugin(ConnectorRegistry, { default: 'build-linux' })
    const registry = ctx.connectors
    const only = descriptor('build-linux')
    registry.register(only, async () => { throw new Error('connection refused') })
    const pending = registry.link().catch(() => undefined)

    await expect(fiber.dispose()).resolves.not.toThrow()
    await pending

    expect(registry.list()).toEqual([])
  })

  it('releases nothing for a connector whose link was never opened', async () => {
    const ctx = await mounted({ default: 'build-linux' })
    const only = descriptor('build-linux')
    const open = vi.fn(async () => stubLink(only))
    await ctx.connectors.register(only, open)()

    expect(open).not.toHaveBeenCalled()
  })
})

describe('target context', () => {
  async function contextText(activeSession: Session | undefined, config: { default?: string }, of?: ConnectorDescriptor) {
    const ctx = new Context()
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ConnectorRegistry, config)
    if (of !== undefined) ctx.connectors.register(of, async () => stubLink(of))
    const assembled = await ctx.systemPrompt.assemble(
      activeSession === undefined ? {} : { agent: { session: activeSession } as unknown as Agent },
    )
    return assembled.contexts.find(entry => entry.name === 'connector:target')?.text
  }

  it('tells the model which machine and path dialect the session runs on', async () => {
    const text = await contextText(session('bound'), { default: 'lab-windows' }, descriptor('lab-windows', 'windows', String.raw`C:\work`))

    expect(text).toContain('connector "lab-windows"')
    expect(text).toContain('a Windows machine')
    expect(text).toContain(String.raw`"C:\\work"`)
  })

  it('names the target OS in product terms', async () => {
    await expect(contextText(session('m'), { default: 'mac' }, descriptor('mac', 'macos', '/Users/build')))
      .resolves.toContain('a macOS machine')
  })

  it('contributes nothing without an agent, a binding, or a registration', async () => {
    await expect(contextText(undefined, { default: 'build-linux' }, descriptor('build-linux'))).resolves.toBe('')
    await expect(contextText(session('unbound'), {})).resolves.toBe('')
    await expect(contextText(session('dangling'), { default: 'absent' })).resolves.toBe('')
  })
})

describe('target path dialect', () => {
  it('selects win32 for a Windows target and posix for every other', () => {
    expect(connectorPathModule('windows')).toBe(win32)
    expect(connectorPathModule('linux')).toBe(posix)
    expect(connectorPathModule('macos')).toBe(posix)
  })
})
