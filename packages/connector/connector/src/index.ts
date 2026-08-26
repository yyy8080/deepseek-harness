/**
 * Service Definition for the connector capability seam (`ctx.connectors`): the registry of
 * configured execution targets, the per-session binding that selects one of
 * them, and the lazily-opened shared link each capability provider operates
 * through.
 *
 * A connector names one machine and one operating-system family. The
 * filesystem and subprocess providers mounted over this seam resolve the same
 * binding at every operation boundary, so a conversation's files, commands, and
 * processes always share one execution world even though the agent loop, model
 * calls, session log, and approvals stay in the harness process.
 *
 * @module @deepseek-ai/dsh-connector
 */

import { posix, win32 } from 'node:path'
import { Context, Service } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type {} from '@deepseek-ai/dsh-agent'
import type { Session } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-system-prompt'
import { ConnectorError, ConnectorId } from './types.ts'
import type { ConnectorDescriptor, ConnectorLink, ConnectorOpener, ConnectorOs } from './types.ts'
import { effectiveConnectorId } from './session-connector.ts'

export { ConnectorError, ConnectorId } from './types.ts'
export type {
  ConnectorDescriptor,
  ConnectorEditRequest,
  ConnectorErrorCode,
  ConnectorFileOperations,
  ConnectorLink,
  ConnectorOpener,
  ConnectorOs,
  ConnectorProcessEvents,
  ConnectorProcessHandle,
  ConnectorProcessOperations,
  ConnectorSpawnSpec,
  ConnectorTarget,
  ConnectorWriteRequest,
} from './types.ts'
export { bindSessionConnector, effectiveConnectorId } from './session-connector.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    connectors: ConnectorRegistry
  }

  interface Events {
    /**
     * A connector's shared link finished opening and is now serving
     * operations. Emitted once per connector until the link is closed.
     * @param descriptor - the connector whose link became live.
     * @mode emit
     */
    'connector/link-opened'(descriptor: ConnectorDescriptor): void
    /**
     * A connector's shared link was released, either because its registration
     * was disposed or because the registry itself is unloading.
     * @param descriptor - the connector whose link is no longer live.
     * @mode emit
     */
    'connector/link-closed'(descriptor: ConnectorDescriptor): void
  }
}

/** Deployment configuration of the connector registry. */
export interface Config {
  /**
   * Connector a session runs on when its log carries no `connector/bound`
   * event. Resolution fails loud when the named connector is not registered,
   * and when it is omitted a session must bind one explicitly.
   */
  default?: string
}

/** Inputs that select the connector for one capability call. */
export interface ConnectorRequest {
  /** Calling session; its last `connector/bound` event outranks the deployment default. */
  session?: Session
}

/** One registered connector and the memoized link opened for it. */
interface Registration {
  descriptor: ConnectorDescriptor
  open: ConnectorOpener
  link?: Promise<ConnectorLink>
}

/** Product names for the model-facing description of a target machine. */
const OS_LABEL: Readonly<Record<ConnectorOs, string>> = {
  linux: 'Linux',
  macos: 'macOS',
  windows: 'Windows',
}

/**
 * The path dialect of a connector's execution world. Every synchronous path
 * computation a connector-backed provider performs — process paths, `file:`
 * URIs, containment — runs in the TARGET's dialect, never the harness host's.
 * @param os - the connector's operating-system family.
 * @returns Node's `win32` path module for a Windows target, `posix` otherwise.
 */
export function connectorPathModule(os: ConnectorOs): typeof posix {
  return os === 'windows' ? win32 : posix
}

/** Describe the target machine to the model in its own path dialect. */
function renderTargetContext(descriptor: ConnectorDescriptor): string {
  const os = OS_LABEL[descriptor.os]
  return `File and command operations in this session run on connector ${JSON.stringify(String(descriptor.id))}, a ${os} machine, not on the machine hosting this conversation. Use ${os} path syntax and commands, and treat ${JSON.stringify(descriptor.workdir)} as the working directory.`
}

/**
 * The connector registry (`ctx.connectors`). Transport plugins register the
 * connectors a deployment configured; capability providers resolve the calling
 * session's connector and operate through its shared link.
 */
export class ConnectorRegistry extends Service {
  // Inline schema call: the config catalog walks `static Config` statically.
  static Config: z<Config> = z.object({
    default: z.string(),
  })

  /** Connector id used by sessions that never bound one, when configured. */
  readonly defaultId: ConnectorId | undefined
  private readonly registrations = new Map<string, Registration>()

  constructor(ctx: Context, config: Config) {
    super(ctx, 'connectors')
    this.defaultId = config.default === undefined ? undefined : ConnectorId(config.default)

    ctx.inject(['systemPrompt'], (scope: Context) => {
      scope.systemPrompt.context({
        name: 'connector:target',
        order: 105,
        text: (context) => {
          const session = context.agent?.session
          if (session === undefined) return ''
          // A bare assembly, an unregistered binding, and an unconfigured
          // default all contribute nothing; the failing operation itself
          // reports the missing connector with its own typed error.
          const descriptor = this.tryDescribe({ session })
          return descriptor === undefined ? '' : renderTargetContext(descriptor)
        },
      })
    })

    ctx.effect(() => async () => {
      const pending = [...this.registrations.values()].map(async registration => this.release(registration))
      this.registrations.clear()
      await Promise.all(pending)
    }, 'connector registry teardown')
  }

  /**
   * Register one connector and the opener its shared link uses. Registering a
   * duplicate id throws: a deployment naming two machines the same way cannot
   * be resolved, and silently keeping one would bind sessions to the wrong
   * target.
   * @param descriptor - the connector's identity, OS family, and workdir.
   * @param open - opens the shared link; called at most once until it closes.
   * @returns the disposer, which closes an opened link and settles once closed.
   */
  register(descriptor: ConnectorDescriptor, open: ConnectorOpener): () => Promise<void> {
    const key = String(descriptor.id)
    if (this.registrations.has(key)) {
      throw new Error(`connector ${JSON.stringify(key)} is already registered`)
    }
    const registration: Registration = { descriptor, open }
    this.registrations.set(key, registration)
    return this.ctx.effect(() => async () => {
      this.registrations.delete(key)
      await this.release(registration)
    }, `connector ${key}`)
  }

  /**
   * Every registered connector, in registration order.
   * @returns the registered descriptors.
   */
  list(): ConnectorDescriptor[] {
    return [...this.registrations.values()].map(registration => registration.descriptor)
  }

  /**
   * Look up one connector without resolving a session binding.
   * @param id - the connector id to look up.
   * @returns the descriptor, or undefined when no registration answers that id.
   */
  get(id: ConnectorId): ConnectorDescriptor | undefined {
    return this.registrations.get(String(id))?.descriptor
  }

  /**
   * Resolve which connector one capability call runs on. The session's last
   * `connector/bound` event outranks the deployment default.
   * @param request - the calling session, when there is one.
   * @returns the resolved connector id.
   */
  resolveId(request: ConnectorRequest = {}): ConnectorId {
    const bound = request.session === undefined ? undefined : effectiveConnectorId(request.session.events)
    const id = bound ?? this.defaultId
    if (id === undefined) {
      throw new ConnectorError(
        'no connector is bound to this session and no default connector is configured',
        'CONNECTOR_UNKNOWN',
      )
    }
    return id
  }

  /**
   * Resolve the connector for one capability call and require its registration.
   * @param request - the calling session, when there is one.
   * @returns the resolved descriptor.
   */
  describe(request: ConnectorRequest = {}): ConnectorDescriptor {
    const id = this.resolveId(request)
    const descriptor = this.get(id)
    if (descriptor === undefined) {
      throw new ConnectorError(`connector ${JSON.stringify(String(id))} is not registered`, 'CONNECTOR_UNKNOWN')
    }
    return descriptor
  }

  /**
   * Resolve the connector for one call without raising when nothing answers.
   * @param request - the calling session, when there is one.
   * @returns the resolved descriptor, or undefined when none can be resolved.
   */
  tryDescribe(request: ConnectorRequest = {}): ConnectorDescriptor | undefined {
    const bound = request.session === undefined ? undefined : effectiveConnectorId(request.session.events)
    const id = bound ?? this.defaultId
    return id === undefined ? undefined : this.get(id)
  }

  /**
   * Obtain the shared live link for one capability call, opening it on first
   * use. Concurrent callers await the same opening; a failed opening is not
   * memoized, so the next call retries.
   * @param request - the calling session, when there is one.
   * @returns the connector's live link.
   */
  async link(request: ConnectorRequest = {}): Promise<ConnectorLink> {
    const descriptor = this.describe(request)
    const registration = this.registrations.get(String(descriptor.id)) as Registration
    const opening = registration.link ?? this.openLink(registration)
    registration.link = opening
    try {
      return await opening
    } catch (error: unknown) {
      if (registration.link === opening) delete registration.link
      throw new ConnectorError(
        `connector ${JSON.stringify(String(descriptor.id))} is unavailable: ${String(error)}`,
        'CONNECTOR_UNAVAILABLE',
        { cause: error },
      )
    }
  }

  private async openLink(registration: Registration): Promise<ConnectorLink> {
    const link = await registration.open()
    this.ctx.emit('connector/link-opened', registration.descriptor)
    return link
  }

  private async release(registration: Registration): Promise<void> {
    const opening = registration.link
    if (opening === undefined) return
    delete registration.link
    // A link that never finished opening still owns its transport, so the
    // close has to wait for the settled result rather than skip it.
    const link = await opening.catch(() => undefined)
    if (link === undefined) return
    await link.close()
    this.ctx.emit('connector/link-closed', registration.descriptor)
  }
}

export default ConnectorRegistry
