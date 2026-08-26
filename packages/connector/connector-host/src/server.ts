/**
 * The connector agent's TCP server: one newline-delimited JSON frame stream per
 * client, a mandatory shared-secret handshake, and a dispatch table over the
 * host execution world.
 *
 * The server grants complete file and command access to whoever holds the
 * token, so it binds to a caller-supplied address (loopback by default in the
 * bin) and expects an operator-provided transport — an `ssh -L` tunnel or a
 * private network — for anything wider.
 *
 * @module @deepseek-ai/dsh-connector-host/server
 */

import { Buffer } from 'node:buffer'
import { timingSafeEqual } from 'node:crypto'
import { createServer } from 'node:net'
import type { AddressInfo, Server, Socket } from 'node:net'
import { ConnectorError } from '@deepseek-ai/dsh-connector'
import type { ConnectorLink, ConnectorProcessHandle, ConnectorSpawnSpec } from '@deepseek-ai/dsh-connector'
import {
  CONNECTOR_PROTOCOL_VERSION,
  ConnectorFrameDecoder,
  encodeFrame,
} from '@deepseek-ai/dsh-connector/protocol'
import type { ConnectorFrame, ConnectorWireError } from '@deepseek-ai/dsh-connector/protocol'
import { FsError } from '@deepseek-ai/dsh-fs'
import { createConnectorHost } from './host.ts'

/** How a connector agent listens for clients. */
export interface ConnectorServeOptions {
  /** Interface address to bind. */
  host: string
  /** TCP port to bind; `0` selects a free port and reports it back. */
  port: number
  /** Shared secret every client must present. Must be non-empty. */
  token: string
  /** Absolute default working directory of the served execution world. */
  workdir: string
}

/** A listening connector agent. */
export interface ConnectorServer {
  /** The bound port, resolved even when `0` was requested. */
  readonly port: number
  /** Stop listening, drop live clients, and release the execution world. */
  close(): Promise<void>
}

/** Compare secrets without leaking their common prefix length through timing. */
function secretsMatch(offered: string, expected: string): boolean {
  const left = Buffer.from(offered, 'utf8')
  const right = Buffer.from(expected, 'utf8')
  return left.length === right.length && timingSafeEqual(left, right)
}

/** Project a thrown value onto the wire so the client can rebuild its class. */
export function wireError(error: unknown): ConnectorWireError {
  if (error instanceof FsError) return { kind: 'fs', code: error.code, message: error.message }
  if (error instanceof ConnectorError) return { kind: 'connector', code: error.code, message: error.message }
  return { kind: 'plain', message: error instanceof Error ? error.message : String(error) }
}

/** Read one positional wire argument that must be a string. */
function wireString(params: readonly unknown[], index: number, method: string): string {
  const value = params[index]
  if (typeof value !== 'string') {
    throw new ConnectorError(`${method} argument ${index} must be a string`, 'CONNECTOR_PROTOCOL')
  }
  return value
}

/** Read one positional wire argument that must be a string or absent. */
function wireOptionalString(params: readonly unknown[], index: number, method: string): string | undefined {
  const value = params[index]
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'string') {
    throw new ConnectorError(`${method} argument ${index} must be a string or null`, 'CONNECTOR_PROTOCOL')
  }
  return value
}

/** Read one positional wire argument that must be a finite number. */
function wireNumber(params: readonly unknown[], index: number, method: string): number {
  const value = params[index]
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new ConnectorError(`${method} argument ${index} must be a number`, 'CONNECTOR_PROTOCOL')
  }
  return value
}

/** Read one positional wire argument that must be an object. */
function wireObject<T>(params: readonly unknown[], index: number, method: string): T {
  const value = params[index]
  if (typeof value !== 'object' || value === null) {
    throw new ConnectorError(`${method} argument ${index} must be an object`, 'CONNECTOR_PROTOCOL')
  }
  return value as T
}

/** Read one positional wire argument that must be an object or absent. */
function wireOptionalRecord(
  params: readonly unknown[],
  index: number,
  method: string,
): Record<string, string> | undefined {
  const value = params[index]
  if (value === undefined || value === null) return undefined
  return wireObject<Record<string, string>>(params, index, method)
}

/**
 * One process the client is observing. The slot is reserved when the spawn
 * call arrives and holds its handle once the target published one, so a
 * failure reported before the spawn round-trip returns cannot resurrect an
 * entry the notification already retired.
 */
interface LiveProcess {
  handle?: ConnectorProcessHandle
}

/** Per-client state: in-flight cancellation and the processes it owns. */
class ConnectorSession {
  private readonly decoder = new ConnectorFrameDecoder()
  private readonly inflight = new Map<number, AbortController>()
  private readonly processes = new Map<number, LiveProcess>()
  private authenticated = false

  constructor(
    private readonly socket: Socket,
    private readonly link: ConnectorLink,
    private readonly token: string,
  ) {}

  /**
   * Consume one transport chunk.
   * @param chunk - UTF-8 text received from the client.
   */
  receive(chunk: string): void {
    let frames: ConnectorFrame[]
    try {
      frames = this.decoder.push(chunk)
    } catch (error: unknown) {
      this.reject(error)
      return
    }
    for (const frame of frames) this.handle(frame)
  }

  /** Release every process this client owned and forget its in-flight calls. */
  release(): void {
    for (const controller of this.inflight.values()) controller.abort()
    this.inflight.clear()
    for (const live of this.processes.values()) void live.handle?.terminate()
    this.processes.clear()
  }

  private reject(error: unknown): void {
    this.send({ t: 'error', id: 0, error: wireError(error) })
    this.socket.destroy()
  }

  private send(frame: ConnectorFrame): void {
    if (this.socket.destroyed) return
    this.socket.write(encodeFrame(frame))
  }

  private handle(frame: ConnectorFrame): void {
    if (!this.authenticated) {
      if (frame.t !== 'hello') {
        this.reject(new ConnectorError('connector client must send hello first', 'CONNECTOR_PROTOCOL'))
        return
      }
      if (frame.protocol !== CONNECTOR_PROTOCOL_VERSION) {
        this.reject(new ConnectorError(
          `connector agent speaks protocol ${CONNECTOR_PROTOCOL_VERSION}, client offered ${String(frame.protocol)}`,
          'CONNECTOR_PROTOCOL',
        ))
        return
      }
      if (!secretsMatch(frame.token, this.token)) {
        this.reject(new ConnectorError('connector token rejected', 'CONNECTOR_UNAVAILABLE'))
        return
      }
      this.authenticated = true
      this.send({
        t: 'ready',
        protocol: CONNECTOR_PROTOCOL_VERSION,
        os: this.link.descriptor.os,
        workdir: this.link.descriptor.workdir,
      })
      return
    }
    if (frame.t === 'cancel') {
      this.inflight.get(frame.id)?.abort()
      return
    }
    if (frame.t !== 'call') {
      this.reject(new ConnectorError(`connector agent cannot accept a ${frame.t} frame`, 'CONNECTOR_PROTOCOL'))
      return
    }
    const controller = new AbortController()
    this.inflight.set(frame.id, controller)
    void this.dispatch(frame.method, frame.params, controller.signal).then(
      (value) => { this.send({ t: 'result', id: frame.id, value }) },
      (error: unknown) => { this.send({ t: 'error', id: frame.id, error: wireError(error) }) },
    ).finally(() => { this.inflight.delete(frame.id) })
  }

  private async dispatch(method: string, params: readonly unknown[], signal: AbortSignal): Promise<unknown> {
    const files = this.link.files
    switch (method) {
      case 'fs.resolve':
        return files.resolve(wireString(params, 0, method), wireOptionalString(params, 1, method), signal)
      case 'fs.stat':
        return (await files.stat(wireString(params, 0, method), signal)) ?? null
      case 'fs.lstat':
        return (await files.lstat(wireString(params, 0, method), wireOptionalString(params, 1, method), signal)) ?? null
      case 'fs.readText':
        return files.readText(wireString(params, 0, method), wireString(params, 1, method), signal)
      case 'fs.readBytes':
        return files.readBytesBase64(
          wireString(params, 0, method),
          wireString(params, 1, method),
          wireNumber(params, 2, method),
          signal,
        )
      case 'fs.listDir':
        return files.listDir(wireString(params, 0, method), wireString(params, 1, method), signal)
      case 'fs.writeText':
        return files.writeText(wireObject(params, 0, method), signal)
      case 'fs.editText':
        return files.editText(wireObject(params, 0, method), signal)
      case 'proc.resolveExecutable':
        return this.link.processes.resolveExecutable(
          wireString(params, 0, method),
          wireOptionalRecord(params, 1, method),
          signal,
        )
      case 'proc.spawn':
        return this.spawn(wireObject<ConnectorSpawnSpec>(params, 0, method), wireNumber(params, 1, method))
      case 'proc.write':
        await this.process(wireNumber(params, 0, method)).write(wireString(params, 1, method))
        return null
      case 'proc.closeStdin':
        await this.process(wireNumber(params, 0, method)).closeStdin()
        return null
      case 'proc.terminate':
        await this.process(wireNumber(params, 0, method)).terminate()
        return null
      default:
        throw new ConnectorError(`connector agent has no method ${JSON.stringify(method)}`, 'CONNECTOR_PROTOCOL')
    }
  }

  private process(id: number): ConnectorProcessHandle {
    const handle = this.processes.get(id)?.handle
    if (handle === undefined) {
      throw new ConnectorError(`connector process ${id} is not live on this connection`, 'CONNECTOR_PROTOCOL')
    }
    return handle
  }

  private async spawn(spec: ConnectorSpawnSpec, id: number): Promise<{ pid: number }> {
    if (this.processes.has(id)) {
      throw new ConnectorError(`connector process ${id} is already live on this connection`, 'CONNECTOR_PROTOCOL')
    }
    const live: LiveProcess = {}
    this.processes.set(id, live)
    const retire = (): void => { this.processes.delete(id) }
    try {
      live.handle = await this.link.processes.spawn(spec, {
        data: (stream, base64) => { this.send({ t: 'event', handle: id, kind: 'data', stream, base64 }) },
        exit: (outcome) => {
          this.send({ t: 'event', handle: id, kind: 'exit', exitCode: outcome.exitCode, signal: outcome.signal })
        },
        failed: (message) => {
          retire()
          this.send({ t: 'event', handle: id, kind: 'failed', message })
        },
        gone: () => {
          retire()
          this.send({ t: 'event', handle: id, kind: 'gone' })
        },
      })
    } catch (error: unknown) {
      retire()
      throw error
    }
    return { pid: live.handle.pid }
  }
}

/**
 * Start a connector agent on this machine.
 * @param options - bind address, shared secret, and served working directory.
 * @returns the listening server, after the port is bound.
 */
export async function serveConnector(options: ConnectorServeOptions): Promise<ConnectorServer> {
  if (options.token.length === 0) throw new Error('connector-host: a non-empty token is required')
  const link = await createConnectorHost({ workdir: options.workdir })
  const sessions = new Set<ConnectorSession>()
  const sockets = new Set<Socket>()
  const server: Server = createServer((socket) => {
    socket.setEncoding('utf8')
    const session = new ConnectorSession(socket, link, options.token)
    sessions.add(session)
    sockets.add(socket)
    socket.on('data', (chunk: string) => { session.receive(chunk) })
    socket.on('error', () => { socket.destroy() })
    socket.on('close', () => {
      session.release()
      sessions.delete(session)
      sockets.delete(socket)
    })
  })
  try {
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(options.port, options.host, () => {
        server.off('error', reject)
        resolve()
      })
    })
  } catch (error: unknown) {
    await link.close()
    throw error
  }
  return {
    port: (server.address() as AddressInfo).port,
    async close(): Promise<void> {
      for (const socket of sockets) socket.destroy()
      await new Promise<void>((resolve) => { server.close(() => { resolve() }) })
      await link.close()
    },
  }
}
