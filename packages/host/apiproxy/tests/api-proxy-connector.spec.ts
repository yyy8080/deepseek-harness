/**
 * `session.create` binding a new conversation's execution world to a
 * connector: the check that runs before anything is created, and the one
 * `connector/bound` event the session carries afterwards.
 */

import { mkdtempSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry, { Inbox } from '@deepseek-ai/dsh-agent'
import type { Agent, AgentFactory } from '@deepseek-ai/dsh-agent'
import ConnectorRegistry, { ConnectorId, effectiveConnectorId } from '@deepseek-ai/dsh-connector'
import type { ConnectorDescriptor } from '@deepseek-ai/dsh-connector'
import SessionStore from '@deepseek-ai/dsh-session'
import type { Session, SessionId } from '@deepseek-ai/dsh-session'
import UserQuestionService from '@deepseek-ai/dsh-user-questions'
import type { RpcRequest, RpcResponse } from '@deepseek-ai/dsh-host-apiproxy/api/rpc'
import { RpcId } from '@deepseek-ai/dsh-host-apiproxy/api/rpc'
import { createApiProxy } from '@deepseek-ai/dsh-host-apiproxy'

let nextRpc = 1

function request<P>(payload: P): RpcRequest<P> {
  return { rpcId: RpcId(`connector-${String(nextRpc++)}`), payload }
}

function expectOk<T>(response: RpcResponse<T>): T {
  expect(response.result.ok).toBe(true)
  if (!response.result.ok) throw new Error('unreachable')
  return response.result.value
}

function stubAgent(session: Session): Agent {
  return {
    id: session.id,
    options: {},
    session,
    inbox: new Inbox(session, { inserted: () => {}, discarded: () => {}, claimed: () => {} }),
    status: 'idle',
    ctx: new Context(),
    send: () => {},
    followup: () => {},
    steer: () => ({ outcome: Promise.resolve({ status: 'rejected' as const }) }),
    inject: () => {},
    cancel() {},
    runMaintenance: job => job(new AbortController().signal),
    whenIdle: () => Promise.resolve(),
  }
}

/** The one descriptor field the gateway reads is the id it was registered under. */
function descriptor(id: string): ConnectorDescriptor {
  return { id: ConnectorId(id), os: 'linux', workdir: '/srv/work' }
}

/**
 * Compose the API over real Session, Agent, and Connector services.
 * @param registered - connector ids this deployment holds registrations for.
 * @returns the API, its context, and the harness working directory.
 */
async function harness(registered: readonly string[] = []) {
  const cwd = realpathSync.native(mkdtempSync(join(tmpdir(), 'dsh-apiproxy-connector-')))
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(UserQuestionService)
  await ctx.plugin(ConnectorRegistry, {})
  ctx.provide('sessionPersistence', { list: () => Promise.resolve([]) } as never)
  for (const id of registered) {
    const target = descriptor(id)
    // The gateway never opens a link — it verifies the registration and writes
    // the binding — so an opener that would reject proves it stays unopened.
    ctx.connectors.register(target, () => Promise.reject(new Error('the gateway must not open a link')))
  }

  const factory: AgentFactory = {
    async createAgent(_ownerCtx, options) {
      const session = ctx.sessions.create(
        options.sessionId,
        options.meta === undefined ? {} : { meta: options.meta },
      )
      const agent = stubAgent(session)
      const unregister = ctx.agents.register(agent)
      return { agent, dispose: () => { unregister(); return Promise.resolve() } }
    },
    async resume() {
      throw new Error('test harness has no persisted sessions')
    },
  }
  ctx.agents.setFactory(factory)
  const api = createApiProxy(ctx, {
    defaultModelSelection: () => ({ provider: 'test', model: 'test-model' }),
    cwd,
  })
  return { api, ctx, cwd }
}

/** The connector one created session is bound to, read back off its log. */
function boundConnector(ctx: Context, sessionId: SessionId): string | undefined {
  const session = ctx.sessions.get(sessionId)
  if (session === undefined) throw new Error(`session ${sessionId} was never created`)
  const bound = effectiveConnectorId(session.events)
  return bound === undefined ? undefined : String(bound)
}

describe('session.create with a connector', () => {
  it('binds the new conversation to the machine the caller named', async () => {
    const { api, ctx } = await harness(['build-box'])

    const { sessionId } = expectOk(await api.sessions.create(request({ connectorId: 'build-box' })))

    expect(boundConnector(ctx, sessionId)).toBe('build-box')
  })

  it('reports the binding to the caller and to every later listing', async () => {
    const { api } = await harness(['build-box'])

    const created = expectOk(await api.sessions.create(request({ connectorId: 'build-box' })))
    const listed = expectOk(await api.sessions.list(request({})))

    // The create echo is what lets a client label the conversation — and keep
    // its composer live — before the first list refresh lands.
    expect(created.connectorId).toBe('build-box')
    expect(listed.items.map(item => item.connectorId)).toEqual(['build-box'])
  })

  it('starts the conversation in the directory the caller asked for', async () => {
    const { api, ctx } = await harness(['build-box'])

    const { sessionId } = expectOk(await api.sessions.create(
      request({ connectorId: 'build-box', cwd: '/srv/on-the-target' }),
    ))

    // The cwd names a directory in the TARGET's world, so the header records
    // it verbatim rather than resolving it against this machine.
    expect(ctx.sessions.get(sessionId)?.header.cwd).toBe('/srv/on-the-target')
  })

  it('leaves a create that names no connector unbound', async () => {
    const { api, ctx } = await harness(['build-box'])

    const { sessionId } = expectOk(await api.sessions.create(request({})))

    expect(boundConnector(ctx, sessionId)).toBeUndefined()
  })

  it('refuses a connector this deployment does not hold, creating nothing', async () => {
    const { api, ctx } = await harness(['build-box'])

    const response = await api.sessions.create(request({ connectorId: 'lab-box' }))

    expect(response.result).toEqual({
      ok: false,
      error: {
        code: 'connector-not-registered',
        message: 'connector "lab-box" is not registered on this deployment',
        details: { connectorId: 'lab-box', available: ['build-box'] },
      },
    })
    // Refusing after publication would leave a conversation pointed at this
    // machine under a UI that promised another one.
    expect(ctx.sessions.list()).toEqual([])
  })

  it('refuses every connector where the deployment composes no registry', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    await ctx.plugin(AgentRegistry)
    await ctx.plugin(UserQuestionService)
    ctx.provide('sessionPersistence', { list: () => Promise.resolve([]) } as never)
    ctx.agents.setFactory({
      createAgent: () => { throw new Error('no session may be created') },
      resume: () => { throw new Error('no session may be resumed') },
    })
    const api = createApiProxy(ctx, {
      defaultModelSelection: () => ({ provider: 'test', model: 'test-model' }),
      cwd: realpathSync.native(mkdtempSync(join(tmpdir(), 'dsh-apiproxy-connector-'))),
    })

    const response = await api.sessions.create(request({ connectorId: 'build-box' }))

    expect(response.result).toMatchObject({
      ok: false,
      error: { code: 'connector-not-registered', details: { available: [] } },
    })
  })
})
