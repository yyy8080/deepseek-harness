/**
 * One stand-in for an isolated runtime: an HTTP server answering the `/api`
 * unary wire plus the two WebSocket downlinks a harness serving `/api` through
 * `@deepseek-ai/dsh-client-connection` upgrades to. The gateway talks to real
 * instances over exactly this wire, so pointing an instance endpoint at one of
 * these exercises the control plane's own client rather than a stub of it.
 */

import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { WebSocketServer, type WebSocket } from 'ws'
import type { HostFrame, MuxFrame, RpcResult } from '@deepseek-ai/dsh-host-apiproxy'

/** One unary call the worker received. */
interface RecordedCall {
  method: string
  payload: unknown
}

/** Answer one unary call; returning `undefined` falls through to a void success. */
export type UnaryHandler = (method: string, payload: unknown) => RpcResult<unknown> | undefined

/** A running fake instance. */
export interface FakeWorker {
  /** HTTP origin the gateway addresses it by. */
  origin: string
  /** Every unary call it received, in arrival order. */
  readonly calls: RecordedCall[]
  /** Push one frame to every attached mux downlink. */
  pushMux(rpcId: string, payload: MuxFrame): void
  /** Push one frame to every attached host downlink. */
  pushHost(rpcId: string, payload: HostFrame): void
  /** Push a raw string to every attached mux downlink, for malformed-frame checks. */
  pushRawMux(text: string): void
  /** Resolves once at least `count` downlinks have been accepted. */
  awaitDownlinks(count: number): Promise<void>
  /** How many downlinks are attached right now. */
  openDownlinks(): number
  /** Close every attached downlink without stopping the worker. */
  closeDownlinks(): void
  /** Body the session-log export answers with. */
  exportBody: string
  close(): Promise<void>
}

/** Frame envelope the downlinks carry, as `client-connection` writes it. */
function envelope(rpcId: string, method: string, payload: unknown): string {
  return JSON.stringify({ type: 'server-request', rpcId, method, payload })
}

/**
 * Start one fake instance on loopback.
 * @param handle - answers unary calls; a void success is the default.
 * @returns the running worker.
 */
export async function startFakeWorker(handle: UnaryHandler = () => undefined): Promise<FakeWorker> {
  const calls: RecordedCall[] = []
  const mux = new Set<WebSocket>()
  const host = new Set<WebSocket>()
  const waiters: (() => void)[] = []
  const worker: FakeWorker = {
    origin: '',
    calls,
    exportBody: 'session-log-zip',
    pushMux: (rpcId, payload) => {
      for (const socket of mux) socket.send(envelope(rpcId, 'events.mux', payload))
    },
    pushHost: (rpcId, payload) => {
      for (const socket of host) socket.send(envelope(rpcId, 'events.host', payload))
    },
    pushRawMux: (text) => {
      for (const socket of mux) socket.send(text)
    },
    awaitDownlinks: count => new Promise<void>((resolve) => {
      const check = (): void => { if (mux.size + host.size >= count) resolve() }
      waiters.push(check)
      check()
    }),
    openDownlinks: () => mux.size + host.size,
    closeDownlinks: () => {
      for (const socket of [...mux, ...host]) socket.close()
    },
    close: async () => {
      for (const socket of [...mux, ...host]) socket.terminate()
      sockets.close()
      await new Promise<void>(resolve => server.close(() => { resolve() }))
    },
  }

  const server: Server = createServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://dsh.internal')
    if (request.method === 'GET' && url.pathname === '/api/session.export') {
      response.writeHead(200, { 'content-type': 'application/zip' })
      response.end(`${worker.exportBody}:${url.searchParams.toString()}`)
      return
    }
    const chunks: Buffer[] = []
    request.on('data', (chunk: Buffer) => chunks.push(chunk))
    request.on('end', () => {
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as {
        rpcId: string
        method?: string
        result?: unknown
      }
      if (url.pathname === '/api/respond') {
        calls.push({ method: 'respond', payload: body })
        response.writeHead(200, { 'content-type': 'application/json' })
        response.end(JSON.stringify({ accepted: true }))
        return
      }
      const method = body.method ?? url.pathname.slice('/api/'.length)
      calls.push({ method, payload: (body as { payload?: unknown }).payload })
      const result = handle(method, (body as { payload?: unknown }).payload) ?? { ok: true, value: {} }
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ type: 'server-response', rpcId: body.rpcId, result }))
    })
  })

  const sockets = new WebSocketServer({ noServer: true })
  server.on('upgrade', (request, socket, head) => {
    const pathname = new URL(request.url ?? '/', 'http://dsh.internal').pathname
    const pool = pathname === '/api/events.mux' ? mux : pathname === '/api/events.host' ? host : undefined
    if (pool === undefined) {
      socket.destroy()
      return
    }
    sockets.handleUpgrade(request, socket, head, (accepted) => {
      pool.add(accepted)
      accepted.on('close', () => pool.delete(accepted))
      for (const waiter of waiters) waiter()
    })
  })

  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  worker.origin = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`
  return worker
}
