import { describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import {
  InstanceError,
  InstanceRegistry,
  type InstanceProvider,
  type InstanceRuntime,
  type InstanceStartRequest,
  type InstanceView,
} from '@deepseek-ai/dsh-instance'

/** A provider whose starts and stops the test drives directly. */
class ScriptedProvider implements InstanceProvider {
  readonly starts: InstanceStartRequest[] = []
  readonly stopped: string[] = []
  /** Rejection installed for the next start, cleared once thrown. */
  failNextStart: string | undefined
  /** Rejection installed for every stop. */
  failStop: string | undefined
  /** Resolves the pending start when set; a start awaits it before answering. */
  gate: Promise<void> | undefined
  /** Throw a non-Error value from the next start, as a foreign backend may. */
  throwNonError = false
  /** Holds every stop open until resolved, so a teardown can be observed mid-flight. */
  stopGate: Promise<void> | undefined
  /** Settles the first time a stop is entered. */
  readonly stopEntered: Promise<void>
  private enterStop = (): void => {}

  constructor(readonly name = 'scripted') {
    this.stopEntered = new Promise<void>((resolve) => { this.enterStop = resolve })
  }

  async start(request: InstanceStartRequest): Promise<InstanceRuntime> {
    this.starts.push(request)
    if (this.gate !== undefined) await this.gate
    // eslint-disable-next-line @typescript-eslint/only-throw-error -- a foreign provider is not bound by this repository's throw discipline
    if (this.throwNonError) throw 'spawn refused'
    const failure = this.failNextStart
    if (failure !== undefined) {
      this.failNextStart = undefined
      throw new Error(failure)
    }
    return {
      endpoint: { origin: `http://127.0.0.1:${String(4000 + this.starts.length)}`, root: `/tmp/${request.id}` },
      stop: async () => {
        this.enterStop()
        if (this.stopGate !== undefined) await this.stopGate
        if (this.failStop !== undefined) throw new Error(this.failStop)
        this.stopped.push(request.id)
      },
    }
  }
}

/** One mounted registry, its announcements, and the fiber that owns it. */
interface Scaffold {
  ctx: Context
  registry: InstanceRegistry
  announced: InstanceView[]
  dispose: () => Promise<void>
}

/** Mount the registry as the plugin it is, so disposal runs its real teardown. */
async function scaffold(): Promise<Scaffold> {
  const ctx = new Context()
  const announced: InstanceView[] = []
  ctx.on('instance/changed', (view) => { announced.push(view) })
  const fiber = await ctx.plugin(InstanceRegistry)
  return { ctx, registry: ctx.instances, announced, dispose: () => fiber.dispose() }
}

describe('InstanceRegistry provider registration', () => {
  it('refuses a second provider under one name and removes the first on disposal', async () => {
    const { registry } = await scaffold()
    const dispose = registry.registerProvider(new ScriptedProvider())
    expect(registry.providerNames).toEqual(['scripted'])
    expect(() => registry.registerProvider(new ScriptedProvider())).toThrow(InstanceError)
    dispose()
    expect(registry.providerNames).toEqual([])
  })

  it('refuses to create an instance for an unregistered provider', async () => {
    const { registry } = await scaffold()
    expect(() => registry.create({ provider: 'absent', label: 'a' }))
      .toThrow(expect.objectContaining({ code: 'NO_PROVIDER' }))
  })
})

describe('InstanceRegistry lifecycle', () => {
  it('creates stopped, starts to running, and announces each committed transition', async () => {
    const { registry, announced } = await scaffold()
    registry.registerProvider(new ScriptedProvider())
    const created = registry.create({ provider: 'scripted', label: 'alpha' })

    expect(created).toMatchObject({ label: 'alpha', desired: 'stopped', lifecycle: 'stopped' })
    expect(created.endpoint).toBeUndefined()

    const started = await registry.start(created.id)
    expect(started).toMatchObject({ desired: 'running', lifecycle: 'running' })
    expect(started.endpoint?.origin).toBe('http://127.0.0.1:4001')
    expect(announced.map(view => view.lifecycle)).toEqual(['stopped', 'starting', 'running'])
    // Every announcement is published after the transition is committed.
    for (const view of announced) expect(registry.get(view.id)?.lifecycle).toBe(registry.get(view.id)?.lifecycle)
  })

  it('publishes an endpoint exactly while running', async () => {
    const { registry, announced } = await scaffold()
    registry.registerProvider(new ScriptedProvider())
    const created = registry.create({ provider: 'scripted', label: 'alpha' })
    await registry.start(created.id)
    await registry.stop(created.id)
    for (const view of announced) {
      expect(view.endpoint !== undefined).toBe(view.lifecycle === 'running')
    }
  })

  it('joins an in-flight start instead of starting a second runtime', async () => {
    const { registry } = await scaffold()
    const provider = new ScriptedProvider()
    registry.registerProvider(provider)
    let release = (): void => {}
    provider.gate = new Promise<void>((resolve) => { release = resolve })
    const created = registry.create({ provider: 'scripted', label: 'alpha' })

    const first = registry.start(created.id)
    const second = registry.start(created.id)
    release()
    const [a, b] = await Promise.all([first, second])

    expect(provider.starts).toHaveLength(1)
    expect(a.endpoint?.origin).toBe(b.endpoint?.origin)
  })

  it('records a failed start and clears the failure on the next attempt', async () => {
    const { registry } = await scaffold()
    const provider = new ScriptedProvider()
    registry.registerProvider(provider)
    provider.failNextStart = 'port already bound'
    const created = registry.create({ provider: 'scripted', label: 'alpha' })

    const failed = await registry.start(created.id)
    expect(failed).toMatchObject({ lifecycle: 'failed', failure: 'port already bound' })
    expect(failed.endpoint).toBeUndefined()

    const retried = await registry.start(created.id)
    expect(retried.lifecycle).toBe('running')
    expect(retried.failure).toBeUndefined()
  })

  it('records a non-Error rejection verbatim', async () => {
    const { registry } = await scaffold()
    const provider = new ScriptedProvider()
    registry.registerProvider(provider)
    provider.throwNonError = true
    const created = registry.create({ provider: 'scripted', label: 'alpha' })

    expect(await registry.start(created.id)).toMatchObject({ lifecycle: 'failed', failure: 'spawn refused' })
  })

  it('fails a start whose provider was unregistered after creation', async () => {
    const { registry } = await scaffold()
    const remove = registry.registerProvider(new ScriptedProvider())
    const created = registry.create({ provider: 'scripted', label: 'alpha' })
    remove()

    await expect(registry.start(created.id)).rejects.toThrow(expect.objectContaining({ code: 'NO_PROVIDER' }))
  })

  it('reports failed rather than stopped when a runtime refuses to stop', async () => {
    const { registry } = await scaffold()
    const provider = new ScriptedProvider()
    registry.registerProvider(provider)
    provider.failStop = 'process would not exit'
    const created = registry.create({ provider: 'scripted', label: 'alpha' })
    await registry.start(created.id)

    const stopped = await registry.stop(created.id)
    expect(stopped).toMatchObject({ lifecycle: 'failed', failure: 'process would not exit' })
  })

  it('refuses a duplicate label and frees it once the instance is removed', async () => {
    const { registry } = await scaffold()
    registry.registerProvider(new ScriptedProvider())
    const created = registry.create({ provider: 'scripted', label: 'alpha' })
    expect(() => registry.create({ provider: 'scripted', label: 'alpha' }))
      .toThrow(expect.objectContaining({ code: 'DUPLICATE_LABEL' }))

    await registry.remove(created.id)
    expect(registry.list()).toEqual([])
    expect(() => registry.create({ provider: 'scripted', label: 'alpha' })).not.toThrow()
  })

  it('never reuses a removed id', async () => {
    const { registry } = await scaffold()
    registry.registerProvider(new ScriptedProvider())
    const first = registry.create({ provider: 'scripted', label: 'alpha' })
    await registry.remove(first.id)
    const second = registry.create({ provider: 'scripted', label: 'beta' })

    expect(second.id).not.toBe(first.id)
    expect(registry.get(first.id)).toBeUndefined()
    await expect(registry.start(first.id)).rejects.toThrow(expect.objectContaining({ code: 'NO_INSTANCE' }))
  })
})

describe('InstanceRegistry placement', () => {
  it('creates and starts on the first call and reuses the same runtime after', async () => {
    const { registry } = await scaffold()
    const provider = new ScriptedProvider()
    registry.registerProvider(provider)

    const first = await registry.ensureRunning({ provider: 'scripted', label: 'alpha' })
    const second = await registry.ensureRunning({ provider: 'scripted', label: 'alpha' })

    expect(provider.starts).toHaveLength(1)
    expect(second.id).toBe(first.id)
    expect(registry.list()).toHaveLength(1)
  })

  it('fails loud when a concurrent stop wins the transition', async () => {
    const { registry } = await scaffold()
    const provider = new ScriptedProvider()
    registry.registerProvider(provider)
    const created = await registry.ensureRunning({ provider: 'scripted', label: 'alpha' })
    let release = (): void => {}
    provider.stopGate = new Promise<void>((resolve) => { release = resolve })

    const stopping = registry.stop(created.id)
    const placing = registry.ensureRunning({ provider: 'scripted', label: 'alpha' })
    release()
    await stopping

    await expect(placing).rejects.toThrow(/did not reach running: stopped/)
  })

  it('fails loud when the runtime never reaches running', async () => {
    const { registry } = await scaffold()
    const provider = new ScriptedProvider()
    registry.registerProvider(provider)
    provider.failNextStart = 'no endpoint'

    await expect(registry.ensureRunning({ provider: 'scripted', label: 'alpha' }))
      .rejects.toThrow(expect.objectContaining({ code: 'START_FAILED' }))
  })
})

describe('InstanceRegistry disposal', () => {
  it('stops every live runtime when the owning fiber disposes', async () => {
    const { registry, dispose } = await scaffold()
    const provider = new ScriptedProvider()
    registry.registerProvider(provider)
    const alpha = await registry.ensureRunning({ provider: 'scripted', label: 'alpha' })
    const beta = await registry.ensureRunning({ provider: 'scripted', label: 'beta' })

    await dispose()

    expect(provider.stopped.sort()).toEqual([alpha.id, beta.id].sort())
  })

  it('reports a runtime that will not die and still reaches the others', async () => {
    const { ctx, registry, dispose } = await scaffold()
    const provider = new ScriptedProvider()
    registry.registerProvider(provider)
    await registry.ensureRunning({ provider: 'scripted', label: 'alpha' })
    provider.failStop = 'stuck'
    const warn = vi.spyOn(ctx.logger, 'warn').mockImplementation(() => {})

    await dispose()

    expect(warn).toHaveBeenCalledWith(expect.stringContaining('did not stop cleanly'))
  })

  it('refuses to create or start anything once disposal has begun', async () => {
    const { registry, dispose } = await scaffold()
    const provider = new ScriptedProvider()
    registry.registerProvider(provider)
    const created = await registry.ensureRunning({ provider: 'scripted', label: 'alpha' })
    let release = (): void => {}
    provider.stopGate = new Promise<void>((resolve) => { release = resolve })

    const disposing = dispose()
    await provider.stopEntered

    expect(() => registry.create({ provider: 'scripted', label: 'beta' }))
      .toThrow(expect.objectContaining({ code: 'REGISTRY_DISPOSING' }))
    await expect(registry.start(created.id)).rejects.toThrow(expect.objectContaining({ code: 'REGISTRY_DISPOSING' }))

    release()
    await disposing
  })

  it('releases a runtime that finishes starting after disposal began', async () => {
    const { registry, dispose } = await scaffold()
    const provider = new ScriptedProvider()
    registry.registerProvider(provider)
    let release = (): void => {}
    provider.gate = new Promise<void>((resolve) => { release = resolve })
    const created = registry.create({ provider: 'scripted', label: 'alpha' })
    const starting = registry.start(created.id)

    const stopping = dispose()
    release()
    const view = await starting
    await stopping

    expect(view.lifecycle).toBe('failed')
    expect(provider.stopped).toEqual([created.id])
  })
})
