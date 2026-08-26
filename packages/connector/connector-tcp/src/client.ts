/**
 * Client half of the connector wire protocol: one TCP socket per connector,
 * correlated calls, and server-initiated process notifications routed back to
 * the handle that started the process.
 * @module @deepseek-ai/dsh-connector-tcp/client
 */

import { connect } from 'node:net'
import type { Socket } from 'node:net'
import { ConnectorError, ConnectorId } from '@deepseek-ai/dsh-connector'
import type {
  ConnectorDescriptor,
  ConnectorEditRequest,
  ConnectorFileOperations,
  ConnectorLink,
  ConnectorOs,
  ConnectorProcessEvents,
  ConnectorProcessHandle,
  ConnectorProcessOperations,
  ConnectorSpawnSpec,
  ConnectorTarget,
  ConnectorWriteRequest,
} from '@deepseek-ai/dsh-connector'
import {
  CONNECTOR_PROTOCOL_VERSION,
  ConnectorFrameDecoder,
  encodeFrame,
} from '@deepseek-ai/dsh-connector/protocol'
import type { ConnectorFrame, ConnectorWireError } from '@deepseek-ai/dsh-connector/protocol'
import { FsError } from '@deepseek-ai/dsh-fs'
import type { FsDirEntry, FsEditOutcome, FsInfo, FsPathInfo, FsWriteOutcome } from '@deepseek-ai/dsh-fs'

/** Everything one TCP connector declaration supplies. */
export interface ConnectorTcpOptions {
  /** Identifier sessions bind to. */
  id: string
  /** Agent host name or address. */
  host: string
  /** Agent TCP port. */
  port: number
  /** Shared secret the agent was started with. */
  token: string
  /** Declared OS family; a disagreeing agent is refused. */
  os: ConnectorOs
  /** Declared default working directory; a disagreeing agent is refused. */
  workdir: string
  /** Deadline for socket connect plus handshake. */
  connectTimeoutMs: number
}

/** Rebuild the error class the agent reported. */
function fromWireError(error: ConnectorWireError): Error {
  if (error.kind === 'fs') return new FsError(error.message, error.code as FsError['code'])
  if (error.kind === 'connector') return new ConnectorError(error.message, error.code as ConnectorError['code'])
  return new Error(error.message)
}

/** One in-flight call awaiting its answer frame. */
interface Pending {
  resolve(value: unknown): void
  reject(error: unknown): void
}

/** One remote process the client still observes. */
interface RemoteProcess {
  events: ConnectorProcessEvents
  settled: boolean
}

/** The multiplexed socket: correlation, cancellation, and event routing. */
class ConnectorTcpTransport {
  private readonly decoder = new ConnectorFrameDecoder()
  private readonly pending = new Map<number, Pending>()
  private readonly processes = new Map<number, RemoteProcess>()
  private nextCall = 1
  private nextProcess = 1
  private failure: Error | undefined

  constructor(private readonly socket: Socket, private readonly id: string) {
    socket.setEncoding('utf8')
    socket.on('data', (chunk: string) => { this.receive(chunk) })
    socket.on('error', (error: Error) => { this.fail(this.transportFailure(error)) })
    socket.on('close', () => {
      this.fail(new ConnectorError(`connector ${JSON.stringify(this.id)} closed the connection`, 'CONNECTOR_UNAVAILABLE'))
    })
  }

  /**
   * Frames arriving before the handshake completes; the opener consumes them.
   * The transport installs its own reader as soon as the handshake resolves.
   */
  onHandshakeFrame: ((frame: ConnectorFrame) => void) | undefined

  /**
   * Invoked at most once, with the failure every later call will throw. The
   * opener uses it so a socket lost mid-handshake reports the same connector
   * failure a socket lost mid-call does, rather than a raw libuv code.
   */
  onLost: ((error: Error) => void) | undefined

  /**
   * Send one call and await its answer.
   * @param method - operation name.
   * @param params - positional arguments.
   * @param signal - aborts the call; the agent is told to cancel it.
   * @returns the operation's return value.
   */
  async call(method: string, params: readonly unknown[], signal: AbortSignal | undefined): Promise<unknown> {
    if (this.failure !== undefined) throw this.failure
    signal?.throwIfAborted()
    const id = this.nextCall
    this.nextCall += 1
    const answer = new Promise<unknown>((resolve, reject) => { this.pending.set(id, { resolve, reject }) })
    this.write({ t: 'call', id, method, params })
    if (signal === undefined) return answer
    const cancel = (): void => { this.write({ t: 'cancel', id }) }
    signal.addEventListener('abort', cancel, { once: true })
    try {
      return await answer
    } finally {
      signal.removeEventListener('abort', cancel)
    }
  }

  /**
   * Claim a process identifier and start observing it, before the spawn that
   * uses it is sent. The client owns the identifier precisely so no
   * notification can arrive ahead of its observer.
   * @param events - callbacks receiving that process's notifications.
   * @returns the identifier to send with the spawn.
   */
  observe(events: ConnectorProcessEvents): number {
    const handle = this.nextProcess
    this.nextProcess += 1
    this.processes.set(handle, { events, settled: false })
    return handle
  }

  /**
   * Stop observing a process whose spawn never reached the target.
   * @param handle - the identifier {@link observe} returned.
   */
  unobserve(handle: number): void {
    this.processes.delete(handle)
  }

  /**
   * Send a frame. A write to an already-dropped socket reports itself through
   * the socket's `error` event, which this transport has already turned into
   * the failure every later call throws.
   * @param frame - the frame to write.
   */
  write(frame: ConnectorFrame): void {
    this.socket.write(encodeFrame(frame))
  }

  /** Drop the socket; pending calls and live processes settle as failures. */
  destroy(): void {
    this.socket.destroy()
  }

  private receive(chunk: string): void {
    let frames: ConnectorFrame[]
    try {
      frames = this.decoder.push(chunk)
    } catch (error: unknown) {
      this.fail(error as Error)
      this.socket.destroy()
      return
    }
    for (const frame of frames) {
      const handshake = this.onHandshakeFrame
      if (handshake !== undefined) {
        handshake(frame)
        continue
      }
      this.route(frame)
    }
  }

  private route(frame: ConnectorFrame): void {
    switch (frame.t) {
      case 'result': {
        this.pending.get(frame.id)?.resolve(frame.value)
        this.pending.delete(frame.id)
        return
      }
      case 'error': {
        this.pending.get(frame.id)?.reject(fromWireError(frame.error))
        this.pending.delete(frame.id)
        return
      }
      case 'event': {
        const process = this.processes.get(frame.handle)
        if (process === undefined) return
        if (frame.kind === 'data') {
          process.events.data(frame.stream ?? 'stdout', frame.base64 ?? '')
          return
        }
        if (frame.kind === 'exit') {
          process.settled = true
          process.events.exit({
            exitCode: frame.exitCode ?? null,
            signal: (frame.signal ?? null) as NodeJS.Signals | null,
          })
          return
        }
        this.processes.delete(frame.handle)
        if (frame.kind === 'gone') process.events.gone()
        else process.events.failed(frame.message ?? 'connector process failed')
        return
      }
      default:
        this.fail(new ConnectorError(
          `connector ${JSON.stringify(this.id)} sent an unexpected ${frame.t} frame`,
          'CONNECTOR_PROTOCOL',
        ))
    }
  }

  /**
   * Restate a socket-level failure as a connector failure, so callers of the
   * seam route on `CONNECTOR_UNAVAILABLE` instead of on libuv codes. A failure
   * this transport itself raised — a handshake deadline, a decode refusal —
   * already carries the right code and passes through unchanged.
   */
  private transportFailure(error: Error): Error {
    if (error instanceof ConnectorError) return error
    return new ConnectorError(
      `connector ${JSON.stringify(this.id)} lost its connection: ${error.message}`,
      'CONNECTOR_UNAVAILABLE',
    )
  }

  private fail(error: Error): void {
    if (this.failure !== undefined) return
    this.failure = error
    for (const pending of this.pending.values()) pending.reject(error)
    this.pending.clear()
    for (const [handle, process] of this.processes) {
      this.processes.delete(handle)
      if (!process.settled) process.events.failed(error.message)
      else process.events.gone()
    }
    this.onLost?.(error)
  }
}

/** Filesystem operations forwarded over the socket. */
class TcpFileOperations implements ConnectorFileOperations {
  constructor(private readonly transport: ConnectorTcpTransport) {}

  async resolve(path: string, cwd: string | undefined, signal: AbortSignal | undefined): Promise<ConnectorTarget> {
    return await this.transport.call('fs.resolve', [path, cwd ?? null], signal) as ConnectorTarget
  }

  async stat(targetKey: string, signal: AbortSignal | undefined): Promise<FsInfo | undefined> {
    return await this.transport.call('fs.stat', [targetKey], signal) as FsInfo | undefined ?? undefined
  }

  async lstat(path: string, cwd: string | undefined, signal: AbortSignal | undefined): Promise<FsPathInfo | undefined> {
    return await this.transport.call('fs.lstat', [path, cwd ?? null], signal) as FsPathInfo | undefined ?? undefined
  }

  async readText(targetKey: string, displayPath: string, signal: AbortSignal | undefined): Promise<string> {
    return await this.transport.call('fs.readText', [targetKey, displayPath], signal) as string
  }

  async readBytesBase64(
    targetKey: string,
    displayPath: string,
    maxBytes: number,
    signal: AbortSignal | undefined,
  ): Promise<string> {
    return await this.transport.call('fs.readBytes', [targetKey, displayPath, maxBytes], signal) as string
  }

  async listDir(targetKey: string, displayPath: string, signal: AbortSignal | undefined): Promise<FsDirEntry[]> {
    return await this.transport.call('fs.listDir', [targetKey, displayPath], signal) as FsDirEntry[]
  }

  async writeText(request: ConnectorWriteRequest, signal: AbortSignal | undefined): Promise<FsWriteOutcome> {
    return await this.transport.call('fs.writeText', [request], signal) as FsWriteOutcome
  }

  async editText(request: ConnectorEditRequest, signal: AbortSignal | undefined): Promise<FsEditOutcome> {
    return await this.transport.call('fs.editText', [request], signal) as FsEditOutcome
  }
}

/** One remote process controlled over the socket. */
class TcpProcessHandle implements ConnectorProcessHandle {
  constructor(
    private readonly transport: ConnectorTcpTransport,
    private readonly handle: number,
    readonly pid: number,
  ) {}

  async write(base64: string): Promise<void> {
    await this.transport.call('proc.write', [this.handle, base64], undefined)
  }

  async closeStdin(): Promise<void> {
    await this.transport.call('proc.closeStdin', [this.handle], undefined)
  }

  async terminate(): Promise<void> {
    // A terminate after the agent already reaped the process is a no-op there
    // and must not surface as a failure here; the same is true once the socket
    // is gone, because the agent tears down that connection's processes.
    await this.transport.call('proc.terminate', [this.handle], undefined).catch(() => undefined)
  }
}

/** Process operations forwarded over the socket. */
class TcpProcessOperations implements ConnectorProcessOperations {
  constructor(private readonly transport: ConnectorTcpTransport) {}

  async resolveExecutable(
    command: string,
    env: Readonly<Record<string, string>> | undefined,
    signal: AbortSignal | undefined,
  ): Promise<string> {
    return await this.transport.call('proc.resolveExecutable', [command, env ?? null], signal) as string
  }

  async spawn(spec: ConnectorSpawnSpec, events: ConnectorProcessEvents): Promise<ConnectorProcessHandle> {
    const handle = this.transport.observe(events)
    try {
      const published = await this.transport.call('proc.spawn', [spec, handle], undefined) as { pid: number }
      return new TcpProcessHandle(this.transport, handle, published.pid)
    } catch (error: unknown) {
      this.transport.unobserve(handle)
      throw error
    }
  }
}

/** Reject the declaration when the agent describes a different machine. */
function checkAgreement(options: ConnectorTcpOptions, os: ConnectorOs, workdir: string): void {
  if (os !== options.os) {
    throw new ConnectorError(
      `connector ${JSON.stringify(options.id)} is declared as ${options.os} but its agent reports ${os}`,
      'CONNECTOR_UNAVAILABLE',
    )
  }
  if (workdir !== options.workdir) {
    throw new ConnectorError(
      `connector ${JSON.stringify(options.id)} is declared with workdir ${JSON.stringify(options.workdir)} but its agent reports ${JSON.stringify(workdir)}`,
      'CONNECTOR_UNAVAILABLE',
    )
  }
}

/**
 * Open one link to a connector agent over TCP.
 * @param options - address, secret, and the declared facts the agent must confirm.
 * @returns the live link, after the handshake succeeds.
 */
export async function openConnectorTcpLink(options: ConnectorTcpOptions): Promise<ConnectorLink> {
  const socket = connect({ host: options.host, port: options.port })
  socket.setNoDelay(true)
  const transport = new ConnectorTcpTransport(socket, options.id)
  const timer = setTimeout(() => {
    socket.destroy(new ConnectorError(
      `connector ${JSON.stringify(options.id)} did not answer within ${options.connectTimeoutMs}ms`,
      'CONNECTOR_UNAVAILABLE',
    ))
  }, options.connectTimeoutMs)
  try {
    const ready = await new Promise<{ os: ConnectorOs; workdir: string }>((resolve, reject) => {
      transport.onHandshakeFrame = (frame): void => {
        if (frame.t === 'ready') {
          if (frame.protocol !== CONNECTOR_PROTOCOL_VERSION) {
            reject(new ConnectorError(
              `connector ${JSON.stringify(options.id)} speaks protocol ${String(frame.protocol)}, this build speaks ${CONNECTOR_PROTOCOL_VERSION}`,
              'CONNECTOR_PROTOCOL',
            ))
            return
          }
          // Cleared synchronously so a frame arriving in the same chunk routes
          // normally instead of reaching the settled handshake handler.
          transport.onHandshakeFrame = undefined
          resolve({ os: frame.os, workdir: frame.workdir })
          return
        }
        reject(frame.t === 'error'
          ? fromWireError(frame.error)
          : new ConnectorError(`connector ${JSON.stringify(options.id)} answered the handshake with a ${frame.t} frame`, 'CONNECTOR_PROTOCOL'))
      }
      transport.onLost = reject
      socket.once('connect', () => {
        transport.write({ t: 'hello', protocol: CONNECTOR_PROTOCOL_VERSION, token: options.token })
      })
    })
    checkAgreement(options, ready.os, ready.workdir)
  } catch (error: unknown) {
    socket.destroy()
    throw error
  } finally {
    transport.onLost = undefined
    clearTimeout(timer)
  }
  const descriptor: ConnectorDescriptor = {
    id: ConnectorId(options.id),
    os: options.os,
    workdir: options.workdir,
  }
  return {
    descriptor,
    files: new TcpFileOperations(transport),
    processes: new TcpProcessOperations(transport),
    close(): Promise<void> {
      transport.destroy()
      return Promise.resolve()
    },
  }
}
