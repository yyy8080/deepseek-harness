/**
 * Service Definition of the instance capability seam (`ctx.instances`): the
 * registry that owns instance identity, the desired/observed state machine,
 * and publication, over a Service Provider protocol that owns isolation
 * mechanics. An instance is a machine-like isolated runtime — a worker
 * process with its own harness home, a container, a remote sandbox — that
 * exposes one harness `/api` gateway; the conversations placed inside it are
 * not this service's concern.
 *
 * Instance identity is deliberately separate from workspace identity: a
 * workspace names a directory a user works in, while an instance names the
 * runtime that directory is reachable from. One instance hosts many
 * workspaces, and the same workspace path may exist in several instances.
 * @module @deepseek-ai/dsh-instance
 */

import { Context, Service } from '@deepseek-ai/cordis'
import type {
  InstanceCreateRequest,
  InstanceDesiredState,
  InstanceId as InstanceIdType,
  InstanceLifecycle,
  InstanceProvider,
  InstanceRuntime,
  InstanceView,
} from './types.ts'

export type {
  InstanceCreateRequest,
  InstanceDesiredState,
  InstanceEndpoint,
  InstanceLifecycle,
  InstanceProvider,
  InstanceRuntime,
  InstanceStartRequest,
  InstanceView,
} from './types.ts'

/** Opaque identity of one isolated runtime. */
export type InstanceId = InstanceIdType

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** The isolated-runtime registry. */
    instances: InstanceRegistry
  }
  interface Events {
    /**
     * One instance's published state changed: creation, every lifecycle
     * transition, and removal. Emitted only after the transition is committed
     * to the registry, so a listener reading `ctx.instances.list()` sees the
     * same value the payload carries. Removal is announced with the final
     * `stopped` or `failed` view followed by nothing further for that id.
     * @param view - the instance's complete published state after the change.
     * @mode emit
     */
    'instance/changed'(view: InstanceView): void
  }
}

/**
 * Environment variable naming the file a managed runtime writes its endpoint
 * into once it is serving requests. The handshake is a file rather than a log
 * line so the runtime can bind an OS-assigned port while its supervisor
 * observes readiness without parsing output, and so a partially written value
 * is never observable (writers rename an already-complete file into place).
 * The file holds `{"origin":"http://127.0.0.1:41234"}`.
 *
 * Protocol constant: a provider that supervises a harness runtime and the
 * runtime it supervises must agree on this name verbatim.
 */
export const INSTANCE_ENDPOINT_FILE_ENV = 'DSH_INSTANCE_ENDPOINT_FILE'

/** Machine-routable instance-registry failures. */
export type InstanceErrorCode =
  | 'DUPLICATE_LABEL'
  | 'DUPLICATE_PROVIDER'
  | 'NO_INSTANCE'
  | 'NO_PROVIDER'
  | 'REGISTRY_DISPOSING'
  | 'START_FAILED'

/** Error carrying a stable {@link InstanceErrorCode}. */
export class InstanceError extends Error {
  /**
   * @param message - human-readable failure description.
   * @param code - the stable routing code.
   */
  constructor(message: string, readonly code: InstanceErrorCode) {
    super(message)
    this.name = 'InstanceError'
  }
}

/**
 * Brand one registry-minted string as an {@link InstanceId}.
 * @param value - raw registry-issued id.
 * @returns the same string with the instance brand.
 */
export function InstanceId(value: string): InstanceId {
  return value as InstanceId
}

/** Mutable registry record behind one published {@link InstanceView}. */
interface InstanceRecord {
  readonly id: InstanceId
  readonly label: string
  readonly provider: string
  desired: InstanceDesiredState
  lifecycle: InstanceLifecycle
  runtime: InstanceRuntime | undefined
  failure: string | undefined
  /** In-flight start or stop, so concurrent callers join instead of racing. */
  transition: Promise<InstanceView> | undefined
  /** Aborts the in-flight start when the registry disposes. */
  starting: AbortController | undefined
}

function viewOf(record: InstanceRecord): InstanceView {
  return {
    id: record.id,
    label: record.label,
    provider: record.provider,
    desired: record.desired,
    lifecycle: record.lifecycle,
    // The endpoint is published exactly while the instance is running. A
    // stopping instance still holds its runtime handle so the stop can reach
    // it, but that endpoint no longer answers and must not be routed to.
    ...record.runtime === undefined || record.lifecycle !== 'running'
      ? {}
      : { endpoint: record.runtime.endpoint },
    ...record.failure === undefined ? {} : { failure: record.failure },
  }
}

function reason(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * Owner of instance identity, state, and publication. Providers own how a
 * runtime is isolated and started; this registry owns what exists, what state
 * it is in, and who is told about it.
 */
export class InstanceRegistry extends Service {
  private readonly providers = new Map<string, InstanceProvider>()
  private readonly records = new Map<InstanceId, InstanceRecord>()
  private sequence = 0
  private disposing = false

  /** @param ctx - owning plugin context. */
  constructor(ctx: Context) {
    super(ctx, 'instances')
    // Every live runtime is a child process or remote allocation this
    // registry alone can still reach once the tree tears down.
    ctx.effect(() => async () => {
      this.disposing = true
      await Promise.all([...this.records.keys()].map(id => this.stopQuietly(id)))
    }, 'instances.runtimes')
  }

  /**
   * Register one runtime backend.
   * @param provider - the backend implementation; its `name` is the registry key.
   * @returns the disposer removing the registration.
   */
  registerProvider(provider: InstanceProvider): () => void {
    if (this.providers.has(provider.name)) {
      throw new InstanceError(`instance provider ${JSON.stringify(provider.name)} is already registered`, 'DUPLICATE_PROVIDER')
    }
    this.providers.set(provider.name, provider)
    return () => { this.providers.delete(provider.name) }
  }

  /** Names of the currently registered runtime backends, in registration order. */
  get providerNames(): string[] {
    return [...this.providers.keys()]
  }

  /**
   * Register one instance in the `stopped` state. Creation never starts a
   * runtime — placement decides that, so a control plane can present the
   * catalog before paying for a cold start.
   * @param request - provider name and human-facing label.
   * @returns the new instance's published state.
   */
  create(request: InstanceCreateRequest): InstanceView {
    if (this.disposing) throw new InstanceError('instance registry is disposing', 'REGISTRY_DISPOSING')
    if (!this.providers.has(request.provider)) {
      throw new InstanceError(`unknown instance provider ${JSON.stringify(request.provider)}`, 'NO_PROVIDER')
    }
    for (const record of this.records.values()) {
      if (record.label === request.label) {
        throw new InstanceError(`instance label ${JSON.stringify(request.label)} is already in use`, 'DUPLICATE_LABEL')
      }
    }
    const record: InstanceRecord = {
      id: InstanceId(`inst-${String(++this.sequence)}`),
      label: request.label,
      provider: request.provider,
      desired: 'stopped',
      lifecycle: 'stopped',
      runtime: undefined,
      failure: undefined,
      transition: undefined,
      starting: undefined,
    }
    this.records.set(record.id, record)
    return this.publish(record)
  }

  /**
   * Read the whole registry.
   * @returns every registered instance's published state, in creation order.
   */
  list(): InstanceView[] {
    return [...this.records.values()].map(viewOf)
  }

  /**
   * Read one instance's published state.
   * @param id - the instance identity.
   * @returns the current view, or `undefined` when no such instance exists.
   */
  get(id: InstanceId): InstanceView | undefined {
    const record = this.records.get(id)
    return record === undefined ? undefined : viewOf(record)
  }

  /**
   * Drive one instance to `running`, joining an in-flight transition rather
   * than starting a second runtime. A previous failure is cleared by the
   * attempt, so a retry reports only its own outcome.
   * @param id - the instance identity.
   * @returns the instance's published state once the transition settles.
   */
  async start(id: InstanceId): Promise<InstanceView> {
    const record = this.require(id)
    if (this.disposing) throw new InstanceError('instance registry is disposing', 'REGISTRY_DISPOSING')
    if (record.transition !== undefined) return record.transition
    if (record.lifecycle === 'running') return viewOf(record)
    const transition = this.runStart(record)
    record.transition = transition
    try {
      return await transition
    } finally {
      record.transition = undefined
    }
  }

  /**
   * Drive one instance to `stopped`, joining an in-flight transition. A stop
   * whose runtime rejects leaves the instance `failed`: the registry does not
   * know whether the runtime is gone, and saying `stopped` would be a lie.
   * @param id - the instance identity.
   * @returns the instance's published state once the transition settles.
   */
  async stop(id: InstanceId): Promise<InstanceView> {
    const record = this.require(id)
    if (record.transition !== undefined) return record.transition
    if (record.lifecycle === 'stopped') {
      record.desired = 'stopped'
      return this.publish(record)
    }
    const transition = this.runStop(record)
    record.transition = transition
    try {
      return await transition
    } finally {
      record.transition = undefined
    }
  }

  /**
   * Stop one instance if needed and drop it from the registry. Removal is
   * final: the id is never reused, so a stale reference fails loud instead of
   * reaching a different runtime.
   * @param id - the instance identity.
   */
  async remove(id: InstanceId): Promise<void> {
    const record = this.require(id)
    await this.stop(id)
    this.records.delete(record.id)
    this.ctx.emit('instance/changed', viewOf(record))
  }

  /**
   * Resolve one running instance, creating and starting it when the label is
   * not yet registered. This is the placement entry point: a control plane
   * asking for "the runtime that hosts this conversation" gets a ready
   * endpoint or a loud failure, never a half-started instance.
   * @param request - provider name and human-facing label.
   * @returns the instance's published state, guaranteed `running`.
   */
  async ensureRunning(request: InstanceCreateRequest): Promise<InstanceView> {
    const existing = [...this.records.values()].find(record => record.label === request.label)
    const id = existing?.id ?? this.create(request).id
    const view = await this.start(id)
    if (view.lifecycle !== 'running') {
      throw new InstanceError(
        `instance ${JSON.stringify(request.label)} did not reach running: ${view.failure ?? view.lifecycle}`,
        'START_FAILED',
      )
    }
    return view
  }

  private require(id: InstanceId): InstanceRecord {
    const record = this.records.get(id)
    if (record === undefined) throw new InstanceError(`unknown instance ${JSON.stringify(id)}`, 'NO_INSTANCE')
    return record
  }

  private publish(record: InstanceRecord): InstanceView {
    const view = viewOf(record)
    this.ctx.emit('instance/changed', view)
    return view
  }

  private async runStart(record: InstanceRecord): Promise<InstanceView> {
    const provider = this.providers.get(record.provider)
    if (provider === undefined) {
      throw new InstanceError(`unknown instance provider ${JSON.stringify(record.provider)}`, 'NO_PROVIDER')
    }
    const abort = new AbortController()
    record.desired = 'running'
    record.lifecycle = 'starting'
    record.failure = undefined
    record.starting = abort
    this.publish(record)
    try {
      const runtime = await provider.start({ id: record.id, label: record.label, signal: abort.signal })
      // The registry disposed while the provider was still bringing the
      // runtime up: nothing will ever read this endpoint, and only this call
      // still holds the handle that can release it.
      if (this.disposing) {
        await runtime.stop()
        throw new InstanceError('instance registry is disposing', 'REGISTRY_DISPOSING')
      }
      record.runtime = runtime
      record.lifecycle = 'running'
    } catch (error: unknown) {
      record.runtime = undefined
      record.lifecycle = 'failed'
      record.failure = reason(error)
    } finally {
      record.starting = undefined
    }
    return this.publish(record)
  }

  private async runStop(record: InstanceRecord): Promise<InstanceView> {
    record.desired = 'stopped'
    record.starting?.abort()
    const runtime = record.runtime
    record.lifecycle = 'stopping'
    this.publish(record)
    try {
      await runtime?.stop()
      record.lifecycle = 'stopped'
      record.failure = undefined
    } catch (error: unknown) {
      record.lifecycle = 'failed'
      record.failure = reason(error)
    } finally {
      record.runtime = undefined
    }
    return this.publish(record)
  }

  /**
   * Teardown-path stop that reports rather than throws: disposal must reach
   * every remaining runtime even when one of them refuses to die.
   */
  private async stopQuietly(id: InstanceId): Promise<void> {
    const view = await this.stop(id)
    // A failure is published exactly while the lifecycle is `failed`, so its
    // presence is the same test as the lifecycle and carries the reason.
    if (view.failure !== undefined) {
      this.ctx.logger.warn(`instance ${view.label} did not stop cleanly: ${view.failure}`)
    }
  }
}

export default InstanceRegistry
