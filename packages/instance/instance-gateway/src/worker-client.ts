/**
 * The control plane's client for one instance's `/api` gateway. The wire is
 * the same one a browser speaks, so an instance needs no gateway-only
 * protocol: `AbstractApiClient` already owns envelope minting, schema
 * validation, and unary correlation, and this subclass supplies Node's fetch
 * against the instance origin.
 *
 * The two event streams are the one place the browser wire and the carrier's
 * in-process SSE form differ. A harness serving `/api` through
 * `@deepseek-ai/dsh-client-connection` answers `GET /api/events.mux` with 426
 * Upgrade Required and carries frames over a WebSocket instead, so this client
 * reads them there rather than through the base class's SSE reader.
 * @module @deepseek-ai/dsh-instance-gateway/worker-client
 */

import { AbstractApiClient } from '@deepseek-ai/dsh-host-apiproxy'
import type { ApiProxy, HostFrame, MuxFrame, RpcRequest } from '@deepseek-ai/dsh-host-apiproxy'
import { serverRequestSchema } from '@deepseek-ai/dsh-host-apiproxy/api'
import { hostFrameSchema, muxFrameSchema } from '@deepseek-ai/dsh-host-apiproxy/api/events.schema'
import type { z } from 'zod'
import { FrameQueue } from './frame-queue.ts'

/** Wire paths of the two downlinks, as `@deepseek-ai/dsh-client-connection` mounts them. */
const MUX_PATH = '/api/events.mux'
const HOST_PATH = '/api/events.host'

/** Fetch-carrier client bound to one instance origin. */
export class WorkerApiClient extends AbstractApiClient {
  /**
   * @param origin - the instance's HTTP origin, without a trailing slash.
   * @param timeoutMs - deadline for bounded unary calls; the streams are unbounded.
   */
  constructor(private readonly origin: string, timeoutMs: number) {
    super(timeoutMs)
  }

  /** Every wire path resolves against the instance, never the control plane's own origin. */
  protected override resolveBase(): string {
    return this.origin
  }

  protected doFetch(input: URL, init?: RequestInit): Promise<Response> {
    return fetch(input, init)
  }

  protected override openMux(
    _payload: Parameters<ApiProxy['events']['mux']>[0]['payload'],
    signal: AbortSignal,
    onOpen?: () => void,
  ): AsyncIterable<RpcRequest<MuxFrame>> {
    return this.readDownlink(MUX_PATH, signal, muxFrameSchema, onOpen)
  }

  protected override openHost(
    _payload: Parameters<ApiProxy['events']['host']>[0]['payload'],
    signal: AbortSignal,
    onOpen?: () => void,
  ): AsyncIterable<RpcRequest<HostFrame>> {
    return this.readDownlink(HOST_PATH, signal, hostFrameSchema, onOpen)
  }

  /**
   * Read one downlink until the caller aborts or the instance closes it.
   * A frame failing either parse level is reported and skipped, matching the
   * SSE reader: one corrupt frame must not end a stream the client's own gap
   * detection can recover from.
   */
  private readDownlink<F extends MuxFrame | HostFrame>(
    path: string,
    signal: AbortSignal,
    frameSchema: z.ZodType<F>,
    onOpen?: () => void,
  ): AsyncIterable<RpcRequest<F>> {
    const queue = new FrameQueue<RpcRequest<F>>()
    const socket = new WebSocket(`${this.origin.replace(/^http/, 'ws')}${path}`)
    socket.addEventListener('open', () => { onOpen?.() })
    socket.addEventListener('message', (event: MessageEvent<unknown>) => {
      // Process wire: the instance is a separate program, so its frames are
      // parsed rather than trusted.
      let frame: F
      try {
        const envelope = serverRequestSchema.parse(JSON.parse(String(event.data)))
        frame = frameSchema.parse(envelope.payload)
        queue.push({ rpcId: envelope.rpcId, payload: frame })
      } catch (error) {
        console.error(`[instance-gateway] dropping malformed frame on ${this.origin}${path}:`, error)
      }
    })
    socket.addEventListener('close', () => { queue.close() })
    socket.addEventListener('error', () => { queue.close() })
    return queue.iterate(signal, () => {
      if (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING) socket.close()
    })
  }
}
