/**
 * The connector download portal: the web surface that turns "I want this
 * machine in the loop" into a running connector.
 *
 * A deployment that already publishes an HTTP origin can hand a user a start
 * script pre-addressed to itself. The user runs it, the agent dials back in
 * over an HTTP upgrade on that same origin, and this plugin registers the
 * machine it serves in `ctx.connectors`. Nothing about the target has to be
 * reachable: no inbound port, no tunnel, no DNS name, no YAML.
 *
 * The portal owns three request paths and one Remote namespace:
 *
 * - `GET <basePath>/pack/<enrollmentId>` renders that enrollment's start
 *   script for its target family. The unguessable id in the path is the
 *   download's only credential, which is why the Remote that mints it is the
 *   authenticated surface and the download itself is not.
 * - `GET <basePath>/agent.mjs` serves the bundled agent program. It carries no
 *   secret — it is the same code for every target — and the pack fetches it.
 * - `UPGRADE <basePath>/attach` accepts an agent's reversed connection.
 * - `connectorPortal` answers `issue`, `list`, and `revoke` for the browser.
 *
 * @module @deepseek-ai/dsh-host-connector-portal
 */

import { Buffer } from 'node:buffer'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import type { IncomingHttpHeaders, IncomingMessage, ServerResponse } from 'node:http'
import type { Duplex, Readable } from 'node:stream'
import type { Socket } from 'node:net'
import { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { ConnectorLink } from '@deepseek-ai/dsh-connector'
import { ConnectorId } from '@deepseek-ai/dsh-connector'
import {
  CONNECTOR_LABEL_HEADER,
  CONNECTOR_TOKEN_HEADER,
  CONNECTOR_UPGRADE_PROTOCOL,
} from '@deepseek-ai/dsh-connector/protocol'
import { openConnectorLinkOverSocket } from '@deepseek-ai/dsh-connector-tcp'
import type {} from '@deepseek-ai/dsh-host-webserver'
import { TypertRemoteService, Remote } from '@deepseek-ai/dsh-typert-protocol'
// Typert-generated ./typert and ./remote artifacts import Zod at runtime.
import type {} from 'zod'
import { ConnectorEnrollments, enrollmentToken } from './enrollment.ts'
import type { ConnectorAttachDecision } from './enrollment.ts'
import { requestOrigin, singleHeader } from './origin.ts'
import {
  assertPackOrigin,
  packContentType,
  packFileName,
  renderConnectorPack,
} from './pack.ts'
import type {
  ConnectorEnrollmentId,
  ConnectorPackRequest,
  ConnectorPackTicket,
  ConnectorPortalSnapshot,
  ConnectorRevokeRequest,
  ConnectorRevokeResult,
} from './types.ts'

export type * from './types.ts'
export { ConnectorEnrollments, enrollmentToken } from './enrollment.ts'
export type { ConnectorAttachDecision, ConnectorAttachRefusal, ConnectorEnrollment } from './enrollment.ts'
export {
  assertPackOrigin,
  packContentType,
  packFileName,
  packInstallCommand,
  renderConnectorPack,
} from './pack.ts'
export type { ConnectorPackSpec } from './pack.ts'
export { requestOrigin, singleHeader } from './origin.ts'

/** Deployment configuration of the connector portal. */
export interface Config {
  /** Route prefix every portal path hangs under. */
  basePath?: string
  /** How long a freshly issued pack stays downloadable, in milliseconds. */
  packTtlMs?: number
  /** How many target machines may be attached at once. */
  maxConnectors?: number
  /**
   * Absolute origin the generated packs dial back to. Leave it unset to derive
   * the origin from each download request, which is what a deployment behind an
   * ordinary reverse proxy wants; set it when the proxy rewrites the Host it
   * forwards.
   */
  publicOrigin?: string
  /**
   * Absolute path of the single-file agent program `<basePath>/agent.mjs`
   * serves. It defaults to the bundle `@deepseek-ai/dsh-connector-host` ships,
   * which `pnpm run build` produces; a deployment that publishes its own build
   * of the agent points this at that file instead.
   */
  agentProgramPath?: string
}

/**
 * The agent program a build of this workspace ships. `import.meta.resolve` maps
 * the export without touching the filesystem, so a checkout that has not been
 * built still loads this module and answers the route with its documented 503.
 */
const BUNDLED_AGENT_PROGRAM = fileURLToPath(
  import.meta.resolve('@deepseek-ai/dsh-connector-host/agent-bundle'),
)

/** Deadline for the connector handshake once an agent's upgrade is accepted. */
const ATTACH_HANDSHAKE_TIMEOUT_MS = 10_000

/** The admitted half of an attach decision, which is all adoption ever sees. */
type AdmittedAttach = Extract<ConnectorAttachDecision, { admitted: true }>

/** Status line and body of each refused attach attempt. */
const REFUSAL_STATUS = {
  'unknown-token': {
    line: '403 Forbidden',
    message: 'connector enrollment is unknown or revoked',
  },
  capacity: {
    line: '503 Service Unavailable',
    message: 'this deployment is already serving its configured connector limit',
  },
} as const

/**
 * The connector portal service (`ctx.connectorPortal`). It owns the enrollment
 * ledger, the routes that serve packs and accept attachments, and the
 * registrations attached targets hold in `ctx.connectors`.
 */
export class ConnectorPortal extends TypertRemoteService {
  static inject = ['connectors', 'webServer']

  // Inline schema call: the config catalog walks `static Config` statically.
  static Config: z<Config> = z.object({
    basePath: z.string().default('/connector'),
    packTtlMs: z.natural().default(1_800_000),
    maxConnectors: z.natural().default(8),
    publicOrigin: z.string(),
    agentProgramPath: z.string().default(BUNDLED_AGENT_PROGRAM),
  })

  private readonly enrollments: ConnectorEnrollments
  private readonly basePath: string
  private readonly publicOrigin: string | undefined
  private readonly agentProgramPath: string

  constructor(ctx: Context, config: Config) {
    super(ctx, 'connectorPortal')
    this.basePath = normalizeBasePath(config.basePath as string)
    this.publicOrigin = config.publicOrigin === undefined ? undefined : assertPackOrigin(config.publicOrigin)
    this.agentProgramPath = config.agentProgramPath as string
    this.enrollments = new ConnectorEnrollments(config.packTtlMs as number, config.maxConnectors as number)

    ctx.effect(() => ctx.webServer.register({
      kind: 'prefix',
      path: this.basePath,
      handler: async (req, res) => this.serve(req, res),
    }), 'connector-portal: pack routes')

    ctx.effect(() => ctx.webServer.registerUpgrade({
      path: `${this.basePath}/attach`,
      handler: (req, socket, head) => { this.accept(req, socket, head) },
    }), 'connector-portal: attach endpoint')

    // Every attachment holds a socket and a connector registration. Releasing
    // them here rather than leaving them to the registry's own teardown covers
    // the target that attached but was never used by a session, whose link the
    // registry has not opened and therefore does not close.
    ctx.effect(() => async () => {
      await Promise.all(this.enrollments.all().map(async record => record.attachment?.release()))
    }, 'connector-portal: attachment teardown')
  }

  /**
   * Mint one enrollment and describe the pack the browser should fetch.
   * @param request - the target family the user picked.
   * @returns the download path, file name, and download deadline.
   */
  @Remote('issue')
  issue(request: ConnectorPackRequest): ConnectorPackTicket {
    const enrollment = this.enrollments.issue(request.os, Date.now())
    const downloadPath = `${this.basePath}/pack/${String(enrollment.id)}`
    return {
      enrollmentId: enrollment.id,
      os: enrollment.os,
      downloadPath,
      fileName: packFileName(enrollment.os),
      installPath: downloadPath,
      expiresAt: enrollment.expiresAt,
    }
  }

  /**
   * Read the current enrollment ledger.
   * @returns every enrollment this deployment holds, oldest first.
   */
  @Remote('list')
  list(): ConnectorPortalSnapshot {
    return { enrollments: this.enrollments.view(Date.now()) }
  }

  /**
   * Discard one enrollment, disconnecting its agent when one is attached.
   * @param request - the enrollment to discard.
   * @returns whether the enrollment was still known.
   */
  @Remote('revoke')
  async revoke(request: ConnectorRevokeRequest): Promise<ConnectorRevokeResult> {
    const enrollment = this.enrollments.remove(String(request.enrollmentId))
    if (enrollment === undefined) return { revoked: false }
    await enrollment.attachment?.release()
    return { revoked: true }
  }

  /** Answer one portal request: a pack download, the agent program, or 404. */
  private async serve(req: IncomingMessage, res: ServerResponse): Promise<void> {
    /* v8 ignore next -- node:http always sets url on server requests */
    const pathname = new URL(req.url ?? '/', 'http://x').pathname
    const suffix = pathname.slice(this.basePath.length)
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      reply(res, 405, 'text/plain; charset=utf-8', 'method not allowed')
      return
    }
    if (suffix === '/agent.mjs') {
      await this.serveAgent(res)
      return
    }
    if (suffix.startsWith('/pack/')) {
      this.servePack(req.headers, suffix.slice('/pack/'.length), res)
      return
    }
    reply(res, 404, 'text/plain; charset=utf-8', 'not found')
  }

  /** Render one enrollment's start script for the origin the browser used. */
  private servePack(headers: IncomingHttpHeaders, id: string, res: ServerResponse): void {
    const enrollment = this.enrollments.claimDownload(decodeURIComponent(id), Date.now())
    if (enrollment === undefined) {
      reply(res, 404, 'text/plain; charset=utf-8', 'this connector pack is unknown or has expired')
      return
    }
    const origin = this.publicOrigin ?? requestOrigin(headers)
    if (origin === undefined) {
      reply(res, 400, 'text/plain; charset=utf-8', 'this request carries no usable origin')
      return
    }
    const body = renderConnectorPack({
      origin,
      attachPath: `${this.basePath}/attach`,
      agentPath: `${this.basePath}/agent.mjs`,
      token: enrollmentToken(enrollment),
      os: enrollment.os,
    })
    res.writeHead(200, {
      'content-type': packContentType(enrollment.os),
      'content-disposition': `attachment; filename="${packFileName(enrollment.os)}"`,
      'cache-control': 'no-store',
    })
    res.end(body)
  }

  /** Serve the single-file agent program the packs fetch. */
  private async serveAgent(res: ServerResponse): Promise<void> {
    let body: Buffer
    try {
      body = await readFile(this.agentProgramPath)
    } catch (error: unknown) {
      this.ctx.logger.warn(`connector-portal: agent program ${JSON.stringify(this.agentProgramPath)} is unreadable: ${String(error)}`)
      reply(res, 503, 'text/plain; charset=utf-8', 'the connector agent program is not available in this build')
      return
    }
    res.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8', 'cache-control': 'no-store' })
    res.end(body)
  }

  /** Admit or refuse one agent's reversed connection. */
  private accept(req: IncomingMessage, socket: Duplex, head: Buffer): void {
    const offered = singleHeader(req.headers, 'upgrade')
    if (offered?.toLowerCase() !== CONNECTOR_UPGRADE_PROTOCOL) {
      socket.destroy()
      return
    }
    const decision = this.enrollments.admitAttach(singleHeader(req.headers, CONNECTOR_TOKEN_HEADER) ?? '')
    if (!decision.admitted) {
      const refusal = REFUSAL_STATUS[decision.refusal]
      socket.end(
        `HTTP/1.1 ${refusal.line}\r\n`
        + 'content-type: text/plain; charset=utf-8\r\n'
        + `content-length: ${String(Buffer.byteLength(refusal.message))}\r\n`
        + 'connection: close\r\n\r\n'
        + refusal.message,
      )
      return
    }
    socket.write(
      'HTTP/1.1 101 Switching Protocols\r\n'
      + 'connection: Upgrade\r\n'
      + `upgrade: ${CONNECTOR_UPGRADE_PROTOCOL}\r\n\r\n`,
    )
    if (head.length > 0) (socket as unknown as Readable).unshift(head)
    void this.adopt(decision, socket as Socket, singleHeader(req.headers, CONNECTOR_LABEL_HEADER))
  }

  /** Complete the connector handshake and register the machine behind it. */
  private async adopt(decision: AdmittedAttach, socket: Socket, label: string | undefined): Promise<void> {
    const enrollment = decision.enrollment
    await enrollment.attachment?.release()
    let link: ConnectorLink
    try {
      link = await openConnectorLinkOverSocket(socket, {
        id: String(enrollment.id),
        token: enrollmentToken(enrollment),
        handshakeTimeoutMs: ATTACH_HANDSHAKE_TIMEOUT_MS,
      })
    } catch (error: unknown) {
      this.ctx.logger.warn(`connector-portal: enrollment ${JSON.stringify(String(enrollment.id))} failed its handshake: ${String(error)}`)
      socket.destroy()
      return
    }
    // The handshake ran with nothing holding the slot, so the enrollment may
    // have been revoked or re-dialled meanwhile. Registering anyway would leave
    // a connector nothing releases, or take the id away from the live agent.
    if (enrollment.attachGeneration !== decision.generation) {
      await link.close()
      return
    }
    const unregister = this.ctx.connectors.register(
      { id: ConnectorId(String(enrollment.id)), os: link.descriptor.os, workdir: link.descriptor.workdir },
      () => Promise.resolve(link),
    )
    let released = false
    const release = async (): Promise<void> => {
      if (released) return
      released = true
      delete enrollment.attachment
      await link.close()
      await unregister()
    }
    enrollment.attachment = {
      label: label ?? link.descriptor.workdir,
      workdir: link.descriptor.workdir,
      attachedAt: Date.now(),
      release,
    }
    socket.once('close', () => { void release() })
    this.ctx.emit('connector-portal/attached', enrollment.id)
  }
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    connectorPortal: ConnectorPortal
  }

  interface Events {
    /**
     * One enrolled target finished its handshake and is now registered in
     * `ctx.connectors`. Emitted once per attachment, including a re-attach
     * after the agent lost and regained its connection.
     * @param enrollmentId - the enrollment whose agent attached.
     * @mode emit
     * @dshScopeScan unsupported
     */
    'connector-portal/attached'(enrollmentId: ConnectorEnrollmentId): void
  }
}

/** Write one short response body. */
function reply(res: ServerResponse, status: number, type: string, body: string): void {
  res.writeHead(status, { 'content-type': type, 'cache-control': 'no-store' })
  res.end(body)
}

/** Refuse a prefix that would not compose into the documented paths. */
function normalizeBasePath(value: string): string {
  if (!value.startsWith('/') || value.endsWith('/') || value.includes('?') || value.includes('#')) {
    throw new Error(`connector-portal: basePath ${JSON.stringify(value)} must be an absolute path without a trailing slash`)
  }
  return value
}

export default ConnectorPortal
