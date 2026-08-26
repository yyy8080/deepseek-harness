/**
 * Consumer of the instance seam that multiplexes many isolated runtimes behind
 * the single `/api` gateway a client already speaks. It provides `ctx.apiProxy`
 * in place of `@deepseek-ai/dsh-host-apiproxy`'s own service, so the browser's
 * HTTP bridge, its two WebSocket downlinks, and the session-log download keep
 * working unchanged while the conversations behind them run somewhere else.
 *
 * The split is by domain. Session-bearing domains — sessions, subagents,
 * skills, goals, the event streams, the client-response channel, session-log
 * downloads — are routed to the instance that owns the session. The host plane
 * — settings, credentials, the model catalog, the workspace registry, host
 * directory browsing — is answered from the control plane's own composition,
 * which this service builds with `createApiProxy`. Ids cross that division
 * through [routing](./routing.ts).
 *
 * Creating a conversation is the placement decision: `session.create` resolves
 * an instance first, starting one when the placement policy asks for a fresh
 * runtime, and only then creates the session inside it. The session's shell,
 * filesystem, and session log therefore live in that runtime from its first
 * event, with no later attachment step.
 * @module @deepseek-ai/dsh-instance-gateway
 */

import { Context, Service } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type {} from '@deepseek-ai/dsh-agent-default-model'
import type {
  ApiProxy,
  ClientResponse,
  HostFrame,
  IApiClient,
  MuxFrame,
  RpcId,
  RpcReceipt,
  RpcRequest,
  RpcResponse,
  RpcResult,
} from '@deepseek-ai/dsh-host-apiproxy'
import { createApiProxy } from '@deepseek-ai/dsh-host-apiproxy'
import { transportError } from '@deepseek-ai/dsh-host-apiproxy/api'
import type { InstanceId, InstanceView } from '@deepseek-ai/dsh-instance'
import { FrameQueue } from './frame-queue.ts'
import { globalize, localize, splitGlobalSessionId } from './routing.ts'
import { WorkerApiClient } from './worker-client.ts'

export {
  globalize,
  globalSessionId,
  INSTANCE_ID_SEPARATOR,
  localize,
  splitGlobalSessionId,
} from './routing.ts'
export type { GlobalSessionId } from './routing.ts'
export { WorkerApiClient } from './worker-client.ts'
export { FrameQueue } from './frame-queue.ts'

/** How the gateway chooses the runtime a new conversation is created in. */
export type InstancePlacement = 'per-conversation' | 'shared'

/** Gateway plugin configuration. */
export interface Config {
  /**
   * Instance provider new conversations are placed on. An unregistered name
   * fails the first placement loudly rather than at load, because providers
   * register on their own fibers and may not have applied yet.
   */
  provider: string
  /**
   * `per-conversation` gives every new conversation its own runtime — full
   * isolation at the cost of one cold start each. `shared` places every
   * conversation in the single runtime named by {@link sharedLabel}, which is
   * the cheap answer when a deployment wants isolation from the control plane
   * rather than between sibling conversations.
   */
  placement?: InstancePlacement
  /** Instance label `shared` placement resolves. */
  sharedLabel?: string
  /**
   * Ceiling on registered instances. Placement past the ceiling fails loudly
   * rather than queueing: each instance is a whole harness runtime, so silently
   * waiting would present as a hung "new chat".
   */
  maxInstances?: number
  /** Deadline for one unary call to an instance. The event streams are unbounded. */
  requestTimeoutMs?: number
}

export const Config: z<Config> = z.object({
  provider: z.string().required(),
  placement: z.union([z.const('per-conversation'), z.const('shared')] as const).default('per-conversation'),
  sharedLabel: z.string().default('shared'),
  maxInstances: z.natural().min(1).default(8),
  requestTimeoutMs: z.natural().min(1).default(60_000),
})

/** Read the session id a routed payload is addressed by. */
type SessionRef<P> = (payload: P) => string

/** Perform one already-routed call against the owning instance's wire client. */
type RoutedCall<P, V> = (client: IApiClient, payload: P) => Promise<RpcResponse<V>>

/**
 * Consume one instance stream into the merged queue, containing every failure:
 * a single instance losing its stream must not end the client's.
 */
async function pump<F>(
  frames: AsyncIterable<RpcRequest<F>>,
  deliver: (frame: RpcRequest<F>) => void,
): Promise<void> {
  try {
    for await (const frame of frames) deliver(frame)
  } catch {
    // The instance's stream ended abnormally: it stopped, was killed, or its
    // socket broke. Its lifecycle is published on `instance/changed`, which is
    // where a client learns about it; the merged stream stays open for the
    // instances that are still answering.
  }
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** The multiplexing gateway, readable by consumers that route by instance. */
    instanceGateway: InstanceGatewayService
  }
}

/**
 * The multiplexing API gateway. Provides `ctx.apiProxy` and, under its own
 * name, the placement entry point instance CRUD consumers share.
 */
export class InstanceGatewayService extends Service implements ApiProxy {
  static inject = [
    'agentDefaultModel', 'agents', 'attachments', 'directoryPicker', 'instances', 'llm', 'sessions',
    'subagents', 'sessionQuery', 'tools', 'userQuestions', 'workspaceRegistry',
  ]

  static Config: z<Config> = Config

  readonly sessions: ApiProxy['sessions']
  readonly subagents: ApiProxy['subagents']
  readonly workspace: ApiProxy['workspace']
  readonly host: ApiProxy['host']
  readonly goals: ApiProxy['goals']
  readonly skills: ApiProxy['skills']
  readonly agentPresets: ApiProxy['agentPresets']
  readonly settings: ApiProxy['settings']
  readonly credentials: ApiProxy['credentials']
  readonly llm: ApiProxy['llm']
  readonly events: ApiProxy['events']
  readonly downloads: ApiProxy['downloads']
  readonly respond: ApiProxy['respond']

  /** The control plane's own gateway, answering the host-plane domains. */
  private readonly local: ApiProxy
  /** One wire client per instance, rebuilt whenever an instance's endpoint changes. */
  private readonly clients = new Map<InstanceId, { origin: string; client: WorkerApiClient }>()
  /** Which instance issued an answerable server-request, so its answer goes back there. */
  private readonly answerable = new Map<RpcId, InstanceId>()

  /**
   * @param ctx - composed control-plane context.
   * @param config - validated {@link Config}.
   */
  constructor(ctx: Context, private readonly config: Config) {
    super(ctx, 'apiProxy')
    this.local = createApiProxy(ctx, {
      defaultModelSelection: () => ctx.agentDefaultModel.currentSelection(),
      saveDefaultModelSelection: selection => ctx.agentDefaultModel.saveSelection(selection),
      cwd: process.cwd(),
      // Every path a client sees belongs to an instance, so there is nothing
      // here a native opener could correctly reveal on the operator's desktop.
      canOpenPath: () => false,
    })

    this.host = this.local.host
    this.workspace = this.local.workspace
    this.agentPresets = this.local.agentPresets
    this.settings = this.local.settings
    this.credentials = this.local.credentials
    this.llm = this.local.llm

    this.sessions = {
      list: request => this.fanIn(request, client => client.sessions.list({}), 'items'),
      search: request => this.fanIn(request, client => client.sessions.search(request.payload), 'items'),
      create: request => this.create(request),
      history: request => this.route(request, p => p.sessionId, (c, p) => c.sessions.history(p)),
      models: request => this.route(request, p => p.sessionId, (c, p) => c.sessions.models(p)),
      selectModel: request => this.route(request, p => p.sessionId, (c, p) => c.sessions.selectModel(p)),
      rename: request => this.route(request, p => p.sessionId, (c, p) => c.sessions.rename(p)),
      fork: request => this.route(request, p => p.sessionId, (c, p) => c.sessions.fork(p)),
      prompt: request => this.route(request, p => p.sessionId, (c, p) => c.sessions.prompt(p)),
      attachment: request => this.route(request, p => p.sessionId, (c, p) => c.sessions.attachment(p)),
      updateQueue: request => this.route(request, p => p.sessionId, (c, p) => c.sessions.updateQueue(p)),
      cancel: request => this.route(request, p => p.sessionId, (c, p) => c.sessions.cancel(p)),
    }

    this.subagents = {
      list: (request, signal) =>
        this.route(request, p => p.parentSessionId, (c, p) => c.subagents.list(p, signal)),
      history: (request, signal) =>
        this.route(request, p => p.parentSessionId, (c, p) => c.subagents.history(p, signal)),
      prompt: (request, signal) =>
        this.route(request, p => p.parentSessionId, (c, p) => c.subagents.prompt(p, signal)),
      interrupt: request =>
        this.route(request, p => p.parentSessionId, (c, p) => c.subagents.interrupt(p)),
    }

    this.skills = {
      list: request => this.route(request, p => p.sessionId, (c, p) => c.skills.list(p)),
    }

    this.goals = {
      create: request => this.route(request, p => p.sessionId, (c, p) => c.goals.create(p)),
      edit: request => this.route(request, p => p.sessionId, (c, p) => c.goals.edit(p)),
      pause: request => this.route(request, p => p.sessionId, (c, p) => c.goals.pause(p)),
      resume: request => this.route(request, p => p.sessionId, (c, p) => c.goals.resume(p)),
      complete: request => this.route(request, p => p.sessionId, (c, p) => c.goals.complete(p)),
      clear: request => this.route(request, p => p.sessionId, (c, p) => c.goals.clear(p)),
    }

    this.events = {
      mux: (request, signal) => this.merge<MuxFrame>(
        signal,
        localSignal => this.local.events.mux(request, localSignal),
        (client, streamSignal) => client.events.mux({}, streamSignal),
        frame => frame.payload.type === 'approval/requested' || frame.payload.type === 'question/requested',
      ),
      host: (request, signal) => this.merge<HostFrame>(
        signal,
        localSignal => this.local.events.host(request, localSignal),
        (client, streamSignal) => client.events.host({}, streamSignal),
        () => false,
      ),
    }

    this.downloads = {
      sessionLog: (request, signal) => this.downloadSessionLog(request, signal),
    }

    this.respond = message => this.forwardResponse(message)

    ctx.on('instance/changed', (view) => { this.dropStaleClient(view) })
  }

  /**
   * Resolve one running instance, starting it when the placement policy asks
   * for a runtime that does not exist yet. The single entry point every "new
   * conversation" path goes through, exposed so an instance-CRUD consumer can
   * pre-warm the same runtime the next `session.create` would resolve.
   * @param conversationKey - stable key of the conversation being placed;
   * `per-conversation` derives the instance label from it so a retried create
   * lands on the same runtime.
   * @returns the resolved instance, guaranteed running.
   */
  async placeConversation(conversationKey: string): Promise<InstanceView> {
    const label = this.config.placement === 'shared'
      ? this.config.sharedLabel ?? 'shared'
      : `conversation-${conversationKey}`
    const maxInstances = this.config.maxInstances ?? 8
    const known = this.ctx.instances.list()
    if (!known.some(view => view.label === label) && known.length >= maxInstances) {
      throw new Error(
        `instance ceiling of ${String(maxInstances)} reached; stop an instance before starting another conversation`,
      )
    }
    return this.ctx.instances.ensureRunning({ provider: this.config.provider, label })
  }

  /** Resolve or rebuild the wire client of one running instance. */
  private clientFor(instanceId: InstanceId): IApiClient {
    const view = this.ctx.instances.get(instanceId)
    if (view?.endpoint === undefined) {
      throw new Error(`instance ${instanceId} is not running (${view?.lifecycle ?? 'unknown'})`)
    }
    const cached = this.clients.get(instanceId)
    if (cached !== undefined && cached.origin === view.endpoint.origin) return cached.client
    const client = new WorkerApiClient(view.endpoint.origin, this.config.requestTimeoutMs ?? 60_000)
    this.clients.set(instanceId, { origin: view.endpoint.origin, client })
    return client
  }

  /** Drop a cached client whose instance no longer answers at the origin it was built for. */
  private dropStaleClient(view: InstanceView): void {
    const cached = this.clients.get(view.id)
    if (cached !== undefined && view.endpoint?.origin !== cached.origin) this.clients.delete(view.id)
  }

  /**
   * Create one conversation inside a freshly resolved instance.
   *
   * Three request fields name the control plane's own world and cannot cross
   * into an instance: `workspaceId` addresses the control-plane workspace
   * registry, `cwd` a control-plane path, and `agentPreset` a roster the worker
   * bundle does not mount. They are dropped rather than forwarded, so the
   * session lands in the instance's own workspace under the instance's own
   * agent.
   */
  private async create(
    request: Parameters<ApiProxy['sessions']['create']>[0],
  ): Promise<Awaited<ReturnType<ApiProxy['sessions']['create']>>> {
    try {
      const preallocated = request.payload.sessionId
      const local = preallocated === undefined
        ? undefined
        : splitGlobalSessionId(preallocated)?.localSessionId ?? preallocated
      const view = await this.placeConversation(local ?? request.rpcId)
      const client = this.clientFor(view.id)
      const response = await client.sessions.create(local === undefined ? {} : { sessionId: local as never })
      return { rpcId: request.rpcId, result: globalize(response.result, view.id) }
    } catch (error: unknown) {
      return { rpcId: request.rpcId, result: transportError(error) }
    }
  }

  /** Route one session-addressed call to the instance that owns the session. */
  private async route<P, V>(
    request: RpcRequest<P>,
    ref: SessionRef<P>,
    call: RoutedCall<P, V>,
  ): Promise<RpcResponse<V>> {
    try {
      const split = splitGlobalSessionId(ref(request.payload))
      if (split === undefined) throw new Error(`session ${JSON.stringify(ref(request.payload))} names no instance`)
      const client = this.clientFor(split.instanceId)
      const response = await call(client, localize(request.payload, split.instanceId))
      return { rpcId: request.rpcId, result: globalize(response.result, split.instanceId) }
    } catch (error: unknown) {
      return { rpcId: request.rpcId, result: transportError(error) }
    }
  }

  /**
   * Ask every running instance and concatenate one array-valued field of the
   * answers. An instance that fails contributes nothing: a listing that omitted
   * every conversation because one runtime is restarting would be worse than
   * one that omits only that runtime's.
   */
  private async fanIn<V extends Record<K, readonly unknown[]>, K extends string>(
    request: RpcRequest<unknown>,
    call: (client: IApiClient) => Promise<RpcResponse<V>>,
    field: K,
  ): Promise<RpcResponse<V>> {
    const running = this.ctx.instances.list().filter(view => view.lifecycle === 'running')
    const answers = await Promise.all(running.map(async (view) => {
      try {
        const response = await call(this.clientFor(view.id))
        return response.result.ok ? globalize(response.result.value, view.id) : undefined
      } catch {
        // One unreachable instance; the merged listing keeps the others.
        return undefined
      }
    }))
    const items: unknown[] = []
    let last: V | undefined
    for (const value of answers) {
      if (value === undefined) continue
      last = value
      items.push(...value[field])
    }
    // Fields beside the concatenated one — `hasMore` on a search — come from
    // the last contributing instance; every instance answers the same bounded
    // page, so the union is "more" whenever any part was.
    const value = { ...(last ?? {}), [field]: items } as V
    return { rpcId: request.rpcId, result: { ok: true, value } }
  }

  /**
   * Merge the control plane's own stream with one stream per running instance,
   * attaching instances that start while the client is connected and detaching
   * those that stop. Instance frames are globalized on the way through, so a
   * client sees one flat stream of addressable sessions.
   */
  private merge<F extends MuxFrame | HostFrame>(
    signal: AbortSignal,
    openLocal: (localSignal: AbortSignal) => AsyncIterable<RpcRequest<F>>,
    openInstance: (client: IApiClient, streamSignal: AbortSignal) => AsyncIterable<RpcRequest<F>>,
    isAnswerable: (frame: RpcRequest<F>) => boolean,
  ): AsyncIterable<RpcRequest<F>> {
    const queue = new FrameQueue<RpcRequest<F>>()
    const attached = new Map<InstanceId, AbortController>()
    const attach = (view: InstanceView): void => {
      if (view.lifecycle !== 'running' || attached.has(view.id)) return
      const abort = new AbortController()
      attached.set(view.id, abort)
      void pump(openInstance(this.clientFor(view.id), abort.signal), (frame) => {
        if (isAnswerable(frame)) this.answerable.set(frame.rpcId, view.id)
        queue.push({ rpcId: frame.rpcId, payload: globalize(frame.payload, view.id) })
      })
    }
    const detach = (view: InstanceView): void => {
      if (view.lifecycle === 'running') return
      const abort = attached.get(view.id)
      if (abort === undefined) return
      attached.delete(view.id)
      abort.abort()
    }
    const localAbort = new AbortController()
    void pump(openLocal(localAbort.signal), (frame) => { queue.push(frame) })
    for (const view of this.ctx.instances.list()) attach(view)
    const off = this.ctx.on('instance/changed', (view) => {
      attach(view)
      detach(view)
    })
    return queue.iterate(signal, () => {
      off()
      localAbort.abort()
      for (const abort of attached.values()) abort.abort()
      attached.clear()
    })
  }

  /** Deliver a client's answer to the instance whose frame asked for it. */
  private async forwardResponse(message: ClientResponse): Promise<RpcReceipt> {
    const instanceId = this.answerable.get(message.rpcId)
    if (instanceId === undefined) return this.local.respond(message)
    this.answerable.delete(message.rpcId)
    try {
      const result: RpcResult<unknown> = localize(message.result, instanceId)
      return await this.clientFor(instanceId).respond({ ...message, result })
    } catch {
      // The instance is gone or unreachable, so the interaction it was waiting
      // on died with it — exactly what a non-pending receipt reports.
      return { accepted: false, reason: 'not-pending' }
    }
  }

  /** Stream one instance's session-log ZIP through, answering 404 for an unroutable id. */
  private async downloadSessionLog(
    request: Parameters<ApiProxy['downloads']['sessionLog']>[0],
    signal: AbortSignal,
  ): Promise<Response> {
    const split = splitGlobalSessionId(request.sessionId)
    if (split === undefined) return this.local.downloads.sessionLog(request, signal)
    const view = this.ctx.instances.get(split.instanceId)
    if (view?.endpoint === undefined) {
      return new Response(`instance ${split.instanceId} is not running`, { status: 404 })
    }
    const url = new URL('/api/session.export', view.endpoint.origin)
    url.searchParams.set('sessionId', split.localSessionId)
    if (request.includeDescendants === true) url.searchParams.set('includeDescendants', 'true')
    return fetch(url, { signal })
  }
}

export default InstanceGatewayService
