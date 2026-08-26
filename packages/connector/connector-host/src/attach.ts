/**
 * Attach mode: the agent dials the harness instead of waiting to be dialled.
 *
 * A target machine is usually the side that cannot accept connections — it
 * sits behind NAT, a corporate firewall, or a laptop's default deny — while the
 * harness deployment already publishes an HTTP origin. Attach mode inverts only
 * who opens the socket: the agent sends an HTTP Upgrade request carrying its
 * enrollment token, and once the deployment answers `101` both peers speak the
 * ordinary connector protocol over that socket with the harness in the client
 * role. Nothing about framing, the handshake, or the operation set changes, so
 * the same {@link serveConnectorSocket} serves both modes.
 *
 * @module @deepseek-ai/dsh-connector-host/attach
 */

import { Buffer } from 'node:buffer'
import { request as httpRequest } from 'node:http'
import { request as httpsRequest } from 'node:https'
import type { IncomingMessage } from 'node:http'
import type { Socket } from 'node:net'
import type { ConnectorLink } from '@deepseek-ai/dsh-connector'
import {
  CONNECTOR_LABEL_HEADER,
  CONNECTOR_TOKEN_HEADER,
  CONNECTOR_UPGRADE_PROTOCOL,
} from '@deepseek-ai/dsh-connector/protocol'
import { serveConnectorSocket } from './server.ts'

/** How an agent reaches the deployment it attaches to. */
export interface ConnectorAttachOptions {
  /** Absolute `http:` or `https:` URL of the deployment's attach endpoint. */
  url: string
  /** Enrollment secret issued with the pack; also the protocol handshake secret. */
  token: string
  /** Operator-facing name the deployment shows for this machine. */
  label: string
  /** The execution world served over each accepted upgrade. */
  link: ConnectorLink
  /** Delay before re-dialling after a lost or refused connection. */
  retryDelayMs: number
  /** Reports each attempt's outcome; the bin prints it. */
  report: (message: string) => void
}

/** One live attachment, or the reason the attempt ended. */
type AttachAttempt =
  | { readonly outcome: 'served'; readonly closed: Promise<void> }
  | { readonly outcome: 'refused'; readonly reason: string }

/** Read the deployment's rejection body so the operator sees why it refused. */
async function refusalReason(response: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = []
  for await (const chunk of response) chunks.push(chunk as Buffer)
  const body = Buffer.concat(chunks).toString('utf8').trim()
  const status = `HTTP ${String(response.statusCode)}`
  return body.length === 0 ? status : `${status}: ${body.slice(0, 200)}`
}

/**
 * Open one upgraded connection and serve the execution world over it.
 * @param options - the deployment endpoint, secret, label, and served world.
 * @param signal - aborts the dial and closes the served connection.
 * @returns the attempt: a promise that settles when the connection closes, or the refusal.
 */
async function attachOnce(options: ConnectorAttachOptions, signal: AbortSignal): Promise<AttachAttempt> {
  const url = new URL(options.url)
  const send: typeof httpRequest = url.protocol === 'https:' ? httpsRequest : httpRequest
  const pending = send(url, {
    method: 'GET',
    headers: {
      connection: 'Upgrade',
      upgrade: CONNECTOR_UPGRADE_PROTOCOL,
      [CONNECTOR_TOKEN_HEADER]: options.token,
      [CONNECTOR_LABEL_HEADER]: options.label,
    },
  })
  return await new Promise<AttachAttempt>((resolve, reject) => {
    const abort = (): void => { pending.destroy(new Error('attach cancelled')) }
    signal.addEventListener('abort', abort, { once: true })
    const settle = (value: AttachAttempt): void => {
      signal.removeEventListener('abort', abort)
      resolve(value)
    }
    pending.on('upgrade', (_response: IncomingMessage, socket: Socket, head: Buffer) => {
      signal.removeEventListener('abort', abort)
      // The deployment sends its `hello` immediately after the 101, so the
      // first frame can already sit in the upgrade head. Push it back before
      // the session installs its reader rather than dropping it.
      if (head.length > 0) socket.unshift(head)
      const release = serveConnectorSocket(socket, options.link, options.token)
      const onAbort = (): void => { release() }
      signal.addEventListener('abort', onAbort, { once: true })
      resolve({
        outcome: 'served',
        closed: new Promise<void>((closed) => {
          socket.once('close', () => {
            signal.removeEventListener('abort', onAbort)
            closed()
          })
        }),
      })
    })
    pending.on('response', (response: IncomingMessage) => {
      void refusalReason(response).then(
        (reason) => { settle({ outcome: 'refused', reason }) },
        (error: unknown) => { settle({ outcome: 'refused', reason: String(error) }) },
      )
    })
    pending.on('error', (error: Error) => {
      signal.removeEventListener('abort', abort)
      reject(error)
    })
    pending.end()
  })
}

/**
 * Whether the caller has stopped the loop. Reading the flag through a call
 * keeps every check current: the loop awaits between them, and narrowing from
 * an earlier read would answer for a signal that has since aborted.
 * @param signal - the caller's stop signal.
 * @returns whether it has been aborted.
 */
function stopped(signal: AbortSignal): boolean {
  return signal.aborted
}

/**
 * Keep one machine attached to a deployment until the caller stops it. Every
 * lost or refused connection is retried: a target left running through a
 * harness restart, a laptop resuming from sleep, and a deployment that is not
 * up yet all reach the same steady state without operator action.
 * @param options - the deployment endpoint, secret, label, served world, and retry delay.
 * @param signal - stops re-dialling and closes the live connection.
 * @returns once the signal has stopped the loop and the live connection is closed.
 */
export async function runConnectorAttachment(
  options: ConnectorAttachOptions,
  signal: AbortSignal,
): Promise<void> {
  while (!stopped(signal)) {
    let attempt: AttachAttempt
    try {
      attempt = await attachOnce(options, signal)
    } catch (error: unknown) {
      attempt = { outcome: 'refused', reason: String(error) }
    }
    if (attempt.outcome === 'served') {
      options.report(`dsh-connector-agent attached to ${options.url} as ${JSON.stringify(options.label)}`)
      await attempt.closed
      if (stopped(signal)) return
      options.report('dsh-connector-agent lost its attachment')
    } else {
      options.report(`dsh-connector-agent could not attach to ${options.url} (${attempt.reason})`)
    }
    await new Promise<void>((done) => {
      const timer = setTimeout(done, options.retryDelayMs)
      signal.addEventListener('abort', () => { clearTimeout(timer); done() }, { once: true })
    })
  }
}
