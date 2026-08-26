import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import UserQuestionService from '@deepseek-ai/dsh-user-questions'
import type { ApiProxy, GoalRef, MuxFrame, RpcRequest, RpcResult } from '@deepseek-ai/dsh-host-apiproxy'
import { RpcId } from '@deepseek-ai/dsh-host-apiproxy/api'
import InstanceRegistry, {
  type InstanceProvider,
  type InstanceRuntime,
  type InstanceStartRequest,
} from '@deepseek-ai/dsh-instance'
import { Config, InstanceGatewayService } from '@deepseek-ai/dsh-instance-gateway'
import { startFakeWorker, type FakeWorker, type UnaryHandler } from './fake-worker.ts'

const workers: FakeWorker[] = []
const disposers: (() => Promise<void>)[] = []

afterEach(async () => {
  await Promise.all(disposers.splice(0).map(dispose => dispose()))
  await Promise.all(workers.splice(0).map(worker => worker.close()))
})

/**
 * A provider that hands every instance one freshly started fake worker, so a
 * gateway call travels the same HTTP and WebSocket wire it would in a
 * deployment.
 */
class WorkerPoolProvider implements InstanceProvider {
  readonly name = 'fake'
  /** Every worker it started, keyed by the instance label. */
  readonly byLabel = new Map<string, FakeWorker>()
  /** Refuses the next start when set. */
  failNextStart: string | undefined

  constructor(private readonly handle: UnaryHandler) {}

  async start(request: InstanceStartRequest): Promise<InstanceRuntime> {
    const failure = this.failNextStart
    if (failure !== undefined) {
      this.failNextStart = undefined
      throw new Error(failure)
    }
    const worker = await startFakeWorker(this.handle)
    workers.push(worker)
    this.byLabel.set(request.label, worker)
    return {
      endpoint: { origin: worker.origin, root: `/tmp/${request.id}` },
      stop: () => worker.close(),
    }
  }
}

interface Harness {
  ctx: Context
  gateway: InstanceGatewayService
  provider: WorkerPoolProvider
}

/**
 * Compose the control plane the gateway runs in. The service is constructed
 * directly rather than mounted so a test can keep the host-plane composition
 * to the three services `createApiProxy` actually reads.
 */
async function harness(
  overrides: Partial<Config> = {},
  handle: UnaryHandler = () => undefined,
): Promise<Harness> {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  await ctx.plugin(UserQuestionService)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(InstanceRegistry)
  ctx.provide('agentDefaultModel', {
    currentSelection: () => ({ provider: 'p', model: 'm' }),
    saveSelection: () => Promise.resolve(),
  } as never)
  // The real registry needs the storage and persistence seams; the gateway
  // only ever forwards to it, so the control plane's own empty catalog is
  // enough to keep the host-plane answers and the host stream honest.
  ctx.provide('workspaceRegistry', { list: () => [], archivedSessionIds: new Set<string>() } as never)
  const provider = new WorkerPoolProvider(handle)
  ctx.instances.registerProvider(provider)
  const gateway = new InstanceGatewayService(ctx, Config({ provider: 'fake', ...overrides }))
  disposers.push(async () => {
    for (const view of ctx.instances.list()) await ctx.instances.remove(view.id)
  })
  return { ctx, gateway, provider }
}

let nextRpc = 0
function request<P>(payload: P): RpcRequest<P> {
  return { rpcId: RpcId(`rpc-${String(++nextRpc)}`), payload }
}

/** The session id `session.create` answered with, or the failure it reported. */
async function created(gateway: ApiProxy, sessionId?: string): Promise<string> {
  const response = await gateway.sessions.create(
    request(sessionId === undefined ? {} : { sessionId: SessionId(sessionId) }),
  )
  if (!response.result.ok) throw new Error(response.result.error.message)
  return response.result.value.sessionId
}

/** One instance-local `session.list` row. */
function summary(sessionId: string): Record<string, unknown> {
  return { sessionId, updatedAt: 1, running: false, blank: true }
}

/** Answer `session.create` with the id the caller asked for, or a fixed minted one. */
const createHandler: UnaryHandler = (method, payload) =>
  method === 'session.create'
    ? { ok: true, value: { sessionId: (payload as { sessionId?: string }).sessionId ?? 'local-1' } }
    : undefined

/** A goal reference as the wire carries it; its id brand is the goal domain's. */
const GOAL_REF = { id: 'g-1', revision: 1 } as unknown as GoalRef
const GOAL_ACK: RpcResult<unknown> = { ok: true, value: { ref: GOAL_REF } }

/** A schema-valid answer for every session-bearing method the gateway routes. */
const ROUTED_ANSWERS: Record<string, RpcResult<unknown>> = {
  'session.create': { ok: true, value: { sessionId: 'local-1' } },
  'session.history': { ok: true, value: { events: [], hasMore: false } },
  'session.models': {
    ok: true,
    value: { current: { provider: 'p', model: 'm' }, routable: true, groups: [], failures: [] },
  },
  'session.selectModel': { ok: true, value: { selected: { provider: 'p', model: 'm' } } },
  'session.rename': { ok: true, value: { title: 'renamed', seq: 1 } },
  'session.fork': { ok: true, value: { sessionId: 'local-2' } },
  'session.prompt': { ok: true, value: { accepted: true } },
  'session.attachment': {
    ok: true,
    value: {
      attachment: { attachmentId: 'a-1', mediaType: 'image/png', bytes: 1, width: 1, height: 1 },
      data: '',
    },
  },
  'session.updateQueue': { ok: true, value: { accepted: true } },
  'session.cancel': { ok: true, value: { accepted: true } },
  'subagent.list': { ok: true, value: { entries: [], parentAvailable: true } },
  'subagent.history': { ok: true, value: { events: [], hasMore: false } },
  'subagent.prompt': { ok: true, value: { messageId: 'm-1' } },
  'subagent.interrupt': { ok: true, value: { accepted: true } },
  'skill.list': { ok: true, value: { skills: [] } },
  'goal.create': GOAL_ACK,
  'goal.edit': GOAL_ACK,
  'goal.pause': GOAL_ACK,
  'goal.resume': GOAL_ACK,
  'goal.complete': GOAL_ACK,
  'goal.clear': { ok: true, value: { cleared: true } },
}

describe('instance gateway placement', () => {
  it('gives every conversation its own runtime and namespaces the session id', async () => {
    const { gateway, ctx } = await harness({}, createHandler)

    const first = await created(gateway)
    const second = await created(gateway)

    expect(first).not.toBe(second)
    expect(first.endsWith('~local-1')).toBe(true)
    expect(ctx.instances.list().map(view => view.lifecycle)).toEqual(['running', 'running'])
  })

  it('places every conversation in one runtime under shared placement', async () => {
    const { gateway, ctx } = await harness({ placement: 'shared', sharedLabel: 'pool' }, createHandler)

    await created(gateway, 'a')
    await created(gateway, 'b')

    expect(ctx.instances.list().map(view => view.label)).toEqual(['pool'])
  })

  it('reuses the runtime a retried create already placed the conversation in', async () => {
    const { gateway, ctx } = await harness({}, createHandler)

    const first = await created(gateway, 'client-chosen')
    const second = await created(gateway, first)

    expect(second).toBe(first)
    expect(ctx.instances.list()).toHaveLength(1)
  })

  it('refuses a placement past the instance ceiling rather than queueing it', async () => {
    const { gateway } = await harness({ maxInstances: 1 }, createHandler)
    await created(gateway)

    const response = await gateway.sessions.create(request({}))

    expect(response.result.ok).toBe(false)
    expect(response.result.ok ? '' : response.result.error.message).toMatch(/instance ceiling of 1 reached/)
  })

  it('reports a runtime that refuses to start as a failed create', async () => {
    const { gateway, provider } = await harness({}, createHandler)
    provider.failNextStart = 'no capacity'

    const response = await gateway.sessions.create(request({}))

    expect(response.result.ok).toBe(false)
    expect(response.result.ok ? '' : response.result.error.message).toMatch(/no capacity/)
  })
})

describe('instance gateway routing', () => {
  it('localizes the request and globalizes the answer of the owning instance', async () => {
    const { gateway, provider } = await harness({}, method =>
      method === 'session.create'
        ? { ok: true, value: { sessionId: 'local-1' } }
        : method === 'session.fork'
          ? { ok: true, value: { sessionId: 'local-2' } }
          : undefined)
    const first = await created(gateway)
    const second = await created(gateway)

    const response = await gateway.sessions.fork(request({ sessionId: SessionId(second) }))

    const [alpha, beta] = [...provider.byLabel.values()]
    expect(response.result).toEqual({ ok: true, value: { sessionId: second.replace('local-1', 'local-2') } })
    expect(alpha?.calls.map(call => call.method)).toEqual(['session.create'])
    expect(beta?.calls.map(call => call.method)).toEqual(['session.create', 'session.fork'])
    expect(beta?.calls[1]?.payload).toEqual({ sessionId: 'local-1' })
    expect(first).not.toBe(second)
  })

  it('refuses a payload naming a session another instance owns', async () => {
    const { gateway } = await harness({}, createHandler)
    const first = await created(gateway)
    const second = await created(gateway)

    const response = await gateway.subagents.history(
      request({
        parentSessionId: SessionId(first),
        childSessionId: SessionId(second),
        mode: 'one-shot' as const,
      }),
      new AbortController().signal,
    )

    expect(response.result.ok ? '' : response.result.error.message)
      .toMatch(/belongs to instance inst-2, not inst-1/)
  })

  it('rejects a session id that names no instance', async () => {
    const { gateway } = await harness({}, createHandler)

    const response = await gateway.sessions.history(request({ sessionId: SessionId('bare-id') }))

    expect(response.result.ok ? '' : response.result.error.message).toMatch(/names no instance/)
  })

  it('rejects a call addressed to an instance that is not running', async () => {
    const { gateway, ctx } = await harness({}, createHandler)
    const sessionId = await created(gateway)
    const [view] = ctx.instances.list()
    await ctx.instances.stop(view!.id)

    const response = await gateway.sessions.history(request({ sessionId: SessionId(sessionId) }))

    expect(response.result.ok ? '' : response.result.error.message).toMatch(/is not running \(stopped\)/)
  })

  it('rejects a call naming an instance the registry never had', async () => {
    const { gateway } = await harness({}, createHandler)

    const response = await gateway.sessions.cancel(request({ sessionId: SessionId('inst-9~local-1') }))

    expect(response.result.ok ? '' : response.result.error.message).toMatch(/inst-9 is not running \(unknown\)/)
  })

  it('routes subagent, skill, and goal calls by their own session field', async () => {
    const answers: Record<string, RpcResult<unknown>> = {
      'session.create': { ok: true, value: { sessionId: 'local-1' } },
      'subagent.list': { ok: true, value: { entries: [], parentAvailable: true } },
      'skill.list': { ok: true, value: { skills: [] } },
      'goal.clear': { ok: true, value: { cleared: true } },
    }
    const { gateway, provider } = await harness({}, method => answers[method])
    const sessionId = await created(gateway)

    await gateway.subagents.list(request({ parentSessionId: SessionId(sessionId) }), new AbortController().signal)
    await gateway.skills.list(request({ sessionId: SessionId(sessionId) }))
    await gateway.goals.clear(request({ sessionId: SessionId(sessionId), ref: GOAL_REF }))

    const worker = [...provider.byLabel.values()][0]
    expect(worker?.calls.map(call => call.method))
      .toEqual(['session.create', 'subagent.list', 'skill.list', 'goal.clear'])
    expect(worker?.calls[1]?.payload).toEqual({ parentSessionId: 'local-1' })
  })

  it('answers host-plane calls from the control plane, never from an instance', async () => {
    const { gateway, provider } = await harness({}, createHandler)
    await created(gateway)

    const workspaces = await gateway.workspace.list(request({}))
    const described = await gateway.host.describe(request({}))

    expect(workspaces.result.ok).toBe(true)
    expect(described.result.ok && described.result.value).toMatchObject({
      provider: 'p',
      model: 'm',
      canOpenPath: false,
    })
    expect([...provider.byLabel.values()][0]?.calls.map(call => call.method)).toEqual(['session.create'])
  })

  /**
   * Every session-bearing method, so a domain method added without a routing
   * entry — or wired to the wrong session field — fails here rather than in a
   * deployment where it reaches the control plane's own empty store.
   */
  const ROUTED: [string, (gateway: ApiProxy, sessionId: string) => Promise<unknown>][] = [
    ['session.history', (gateway, sessionId) => gateway.sessions.history(request({ sessionId: SessionId(sessionId) }))],
    ['session.models', (gateway, sessionId) => gateway.sessions.models(request({ sessionId: SessionId(sessionId) }))],
    ['session.selectModel', (gateway, sessionId) => gateway.sessions.selectModel(
      request({ sessionId: SessionId(sessionId), provider: 'p', model: 'm' }),
    )],
    ['session.rename', (gateway, sessionId) => gateway.sessions.rename(
      request({ sessionId: SessionId(sessionId), title: 'renamed' }),
    )],
    ['session.fork', (gateway, sessionId) => gateway.sessions.fork(request({ sessionId: SessionId(sessionId) }))],
    ['session.prompt', (gateway, sessionId) => gateway.sessions.prompt(
      request({ sessionId: SessionId(sessionId), mode: 'queue' as const, content: [] }),
    )],
    ['session.attachment', (gateway, sessionId) => gateway.sessions.attachment(
      request({ sessionId: SessionId(sessionId), attachmentId: 'a-1' as never }),
    )],
    ['session.updateQueue', (gateway, sessionId) => gateway.sessions.updateQueue(
      request({ sessionId: SessionId(sessionId), itemId: 'm-1' as never, action: { kind: 'remove' } }),
    )],
    ['session.cancel', (gateway, sessionId) => gateway.sessions.cancel(request({ sessionId: SessionId(sessionId) }))],
    ['subagent.list', (gateway, sessionId) => gateway.subagents.list(
      request({ parentSessionId: SessionId(sessionId) }),
      new AbortController().signal,
    )],
    ['subagent.history', (gateway, sessionId) => gateway.subagents.history(
      request({
        parentSessionId: SessionId(sessionId),
        childSessionId: SessionId(sessionId),
        mode: 'one-shot' as const,
      }),
      new AbortController().signal,
    )],
    ['subagent.prompt', (gateway, sessionId) => gateway.subagents.prompt(
      request({
        parentSessionId: SessionId(sessionId),
        childSessionId: SessionId(sessionId),
        mode: 'continuable' as const,
        content: [],
      }),
      new AbortController().signal,
    )],
    ['subagent.interrupt', (gateway, sessionId) => gateway.subagents.interrupt(
      request({
        parentSessionId: SessionId(sessionId),
        childSessionId: SessionId(sessionId),
        mode: 'continuable' as const,
      }),
    )],
    ['skill.list', (gateway, sessionId) => gateway.skills.list(request({ sessionId: SessionId(sessionId) }))],
    ['goal.create', (gateway, sessionId) => gateway.goals.create(
      request({ sessionId: SessionId(sessionId), objective: 'ship' }),
    )],
    ['goal.edit', (gateway, sessionId) => gateway.goals.edit(
      request({ sessionId: SessionId(sessionId), ref: GOAL_REF, objective: 'ship' }),
    )],
    ['goal.pause', (gateway, sessionId) => gateway.goals.pause(
      request({ sessionId: SessionId(sessionId), ref: GOAL_REF }),
    )],
    ['goal.resume', (gateway, sessionId) => gateway.goals.resume(
      request({ sessionId: SessionId(sessionId), ref: GOAL_REF }),
    )],
    ['goal.complete', (gateway, sessionId) => gateway.goals.complete(
      request({ sessionId: SessionId(sessionId), ref: GOAL_REF }),
    )],
    ['goal.clear', (gateway, sessionId) => gateway.goals.clear(
      request({ sessionId: SessionId(sessionId), ref: GOAL_REF }),
    )],
  ]

  it.each(ROUTED)('routes %s to the instance that owns the session', async (method, call) => {
    const { gateway, provider } = await harness({}, name => ROUTED_ANSWERS[name])
    const sessionId = await created(gateway)

    await call(gateway, sessionId)

    const worker = [...provider.byLabel.values()][0]
    expect(worker?.calls.map(entry => entry.method)).toEqual(['session.create', method])
    expect(JSON.stringify(worker?.calls[1]?.payload)).not.toContain('~')
  })
})

describe('instance gateway fan-in', () => {
  it('concatenates every running instance listing and skips the ones that fail', async () => {
    const { gateway, provider, ctx } = await harness({}, method =>
      method === 'session.create'
        ? { ok: true, value: { sessionId: 'local-1' } }
        : method === 'session.list'
          ? { ok: true, value: { items: [summary('local-1')] } }
          : undefined)
    await created(gateway)
    await created(gateway)

    const response = await gateway.sessions.list(request({}))
    const items = response.result.ok
      ? (response.result.value as { items: { sessionId: string }[] }).items
      : []

    expect(items.map(item => item.sessionId).sort())
      .toEqual(ctx.instances.list().map(view => `${view.id}~local-1`).sort())
    expect(provider.byLabel.size).toBe(2)
  })

  it('keeps the listing when one instance answers with a failure', async () => {
    let calls = 0
    const { gateway } = await harness({}, (method) => {
      if (method === 'session.create') return { ok: true, value: { sessionId: 'local-1' } }
      if (method !== 'session.list') return undefined
      calls += 1
      return calls === 1
        ? { ok: false, error: { code: 'internal', message: 'busy', details: {} } }
        : { ok: true, value: { items: [summary('local-1')] } }
    })
    await created(gateway)
    await created(gateway)

    const response = await gateway.sessions.list(request({}))

    expect(response.result.ok && (response.result.value as { items: unknown[] }).items).toHaveLength(1)
  })

  it('omits an instance that is registered as running but unreachable', async () => {
    const { gateway, provider } = await harness({}, method =>
      method === 'session.create'
        ? { ok: true, value: { sessionId: 'local-1' } }
        : method === 'session.list'
          ? { ok: true, value: { items: [summary('local-1')] } }
          : undefined)
    await created(gateway)
    await created(gateway)
    // The registry still calls it running; only its wire is gone.
    await [...provider.byLabel.values()][0]!.close()

    const response = await gateway.sessions.list(request({}))

    expect(response.result.ok && (response.result.value as { items: unknown[] }).items).toHaveLength(1)
  })

  it('answers an empty listing when no instance is running', async () => {
    const { gateway } = await harness({}, createHandler)

    const response = await gateway.sessions.list(request({}))

    expect(response.result).toEqual({ ok: true, value: { items: [] } })
  })

  it('forwards the search payload and merges the pages', async () => {
    const { gateway } = await harness({}, (method, payload) =>
      method === 'session.create'
        ? { ok: true, value: { sessionId: 'local-1' } }
        : method === 'session.search'
          ? {
            ok: true,
            value: {
              items: [{ sessionId: 'local-1', snippet: (payload as { query: string }).query, updatedAt: 1, seq: 1 }],
              hasMore: true,
            },
          }
          : undefined)
    await created(gateway)

    const response = await gateway.sessions.search(request({ query: 'needle' }), new AbortController().signal)
    const value = response.result.ok
      ? response.result.value as { items: { snippet: string }[]; hasMore: boolean }
      : undefined

    expect(value?.items[0]?.snippet).toBe('needle')
    expect(value?.hasMore).toBe(true)
  })
})

describe('instance gateway event merging', () => {
  it('republishes instance frames under global session ids and attaches late instances', async () => {
    const { gateway, provider } = await harness({}, createHandler)
    const abort = new AbortController()
    const seen: RpcRequest<MuxFrame>[] = []
    const first = await created(gateway)

    void (async () => {
      for await (const frame of gateway.events.mux(request({}), abort.signal)) seen.push(frame)
    })()
    const alpha = [...provider.byLabel.values()][0]!
    await alpha.awaitDownlinks(1)
    alpha.pushMux('r-1', { type: 'session/subscribed', sessionId: SessionId('local-1'), lastSeq: 0 })
    await vi.waitFor(() => { expect(seen).toHaveLength(1) })

    const second = await created(gateway)
    const beta = [...provider.byLabel.values()][1]!
    await beta.awaitDownlinks(1)
    beta.pushMux('r-2', { type: 'session/subscribed', sessionId: SessionId('local-1'), lastSeq: 1 })
    await vi.waitFor(() => { expect(seen).toHaveLength(2) })

    expect(seen.map(frame => (frame.payload as { sessionId: string }).sessionId)).toEqual([first, second])
    abort.abort()
  })

  it('detaches an instance that stops and leaves the merged stream open', async () => {
    const { gateway, provider, ctx } = await harness({}, createHandler)
    const abort = new AbortController()
    const seen: RpcRequest<MuxFrame>[] = []
    await created(gateway)

    void (async () => {
      for await (const frame of gateway.events.mux(request({}), abort.signal)) seen.push(frame)
    })()
    const alpha = [...provider.byLabel.values()][0]!
    await alpha.awaitDownlinks(1)
    await ctx.instances.stop(ctx.instances.list()[0]!.id)

    await vi.waitFor(() => { expect(alpha.openDownlinks()).toBe(0) })
    abort.abort()
    expect(seen).toEqual([])
  })

  it('carries the control plane own frames on the same merged stream', async () => {
    const { gateway, ctx } = await harness({}, createHandler)
    const abort = new AbortController()
    const seen: unknown[] = []

    void (async () => {
      for await (const frame of gateway.events.host(request({}), abort.signal)) seen.push(frame.payload)
    })()
    await new Promise<void>((settle) => { setTimeout(settle, 10) })
    const session = ctx.sessions.create()

    await vi.waitFor(() => {
      expect(seen).toContainEqual(expect.objectContaining({
        type: 'host/session-added',
        sessionId: session.id,
      }))
    })
    abort.abort()
  })

  it('merges the host stream without answerable tracking', async () => {
    const { gateway, provider } = await harness({}, createHandler)
    const abort = new AbortController()
    const seen: unknown[] = []
    const sessionId = await created(gateway)

    void (async () => {
      for await (const frame of gateway.events.host(request({}), abort.signal)) seen.push(frame.payload)
    })()
    const alpha = [...provider.byLabel.values()][0]!
    await alpha.awaitDownlinks(1)
    alpha.pushHost('h-1', { type: 'host/session-removed', sessionId: SessionId('local-1') })

    await vi.waitFor(() => { expect(seen).toEqual([{ type: 'host/session-removed', sessionId }]) })
    abort.abort()
  })
})

describe('instance gateway client responses', () => {
  it('sends an answer back to the instance whose frame asked for it', async () => {
    const { gateway, provider } = await harness({}, createHandler)
    const abort = new AbortController()
    const sessionId = await created(gateway)
    void (async () => { for await (const _ of gateway.events.mux(request({}), abort.signal)) void _ })()
    const alpha = [...provider.byLabel.values()][0]!
    await alpha.awaitDownlinks(1)
    alpha.pushMux('ask-1', {
      type: 'question/requested',
      sessionId: SessionId('local-1'),
      questions: [{ id: 'q1', question: 'proceed?' }],
    })
    await vi.waitFor(() => { expect(alpha.openDownlinks()).toBe(1) })
    await new Promise<void>((settle) => { setTimeout(settle, 20) })

    const receipt = await gateway.respond({
      type: 'client-response',
      rpcId: RpcId('ask-1'),
      result: { ok: true, value: { sessionId } },
    } as never)

    expect(receipt).toEqual({ accepted: true })
    expect(alpha.calls.at(-1)?.method).toBe('respond')
    abort.abort()
  })

  it('reports a non-pending receipt when the instance died before the answer', async () => {
    const { gateway, provider, ctx } = await harness({}, createHandler)
    const abort = new AbortController()
    await created(gateway)
    void (async () => { for await (const _ of gateway.events.mux(request({}), abort.signal)) void _ })()
    const alpha = [...provider.byLabel.values()][0]!
    await alpha.awaitDownlinks(1)
    alpha.pushMux('ask-2', {
      type: 'approval/requested',
      sessionId: SessionId('local-1'),
      approvalId: 'ap-1' as never,
      toolName: 'bash',
    })
    await new Promise<void>((settle) => { setTimeout(settle, 20) })
    await ctx.instances.stop(ctx.instances.list()[0]!.id)

    const receipt = await gateway.respond({
      type: 'client-response',
      rpcId: RpcId('ask-2'),
      result: { ok: true, value: {} },
    } as never)

    expect(receipt).toEqual({ accepted: false, reason: 'not-pending' })
    abort.abort()
  })

  it('reports a non-pending receipt when no instance asked the question', async () => {
    const { gateway } = await harness({}, createHandler)

    const receipt = await gateway.respond({
      type: 'client-response',
      rpcId: RpcId('unknown'),
      result: { ok: true, value: {} },
    } as never)

    expect(receipt).toEqual({ accepted: false, reason: 'not-pending' })
  })
})

describe('instance gateway session-log download', () => {
  it('streams the owning instance export through', async () => {
    const { gateway } = await harness({}, createHandler)
    const sessionId = await created(gateway)

    const response = await gateway.downloads.sessionLog(
      { sessionId: SessionId(sessionId), includeDescendants: true },
      new AbortController().signal,
    )

    expect(await response.text()).toBe('session-log-zip:sessionId=local-1&includeDescendants=true')
  })

  it('asks only for the named session when descendants are not requested', async () => {
    const { gateway } = await harness({}, createHandler)
    const sessionId = await created(gateway)

    const response = await gateway.downloads.sessionLog(
      { sessionId: SessionId(sessionId) },
      new AbortController().signal,
    )

    expect(await response.text()).toBe('session-log-zip:sessionId=local-1')
  })

  it('answers 404 for a session whose instance is not running', async () => {
    const { gateway, ctx } = await harness({}, createHandler)
    const sessionId = await created(gateway)
    await ctx.instances.stop(ctx.instances.list()[0]!.id)

    const response = await gateway.downloads.sessionLog(
      { sessionId: SessionId(sessionId) },
      new AbortController().signal,
    )

    expect(response.status).toBe(404)
  })

  it('falls through to the control plane for an id that names no instance', async () => {
    const { gateway } = await harness({}, createHandler)

    const response = await gateway.downloads.sessionLog(
      { sessionId: SessionId('bare-id') },
      new AbortController().signal,
    )

    expect(await response.text()).toMatch(/session log export is unavailable/)
  })
})
