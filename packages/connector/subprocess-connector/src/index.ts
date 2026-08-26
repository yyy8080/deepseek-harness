/**
 * Connector-backed implementation of `ctx.subprocess`. Executable lookup and
 * managed process trees run on the machine the calling session is bound to,
 * while stdio dispositions, collection limits, and cancellation stay in the
 * harness process where their consumers live.
 *
 * The seam publishes a handle synchronously but a remote spawn cannot, so the
 * handle's `pid`, stdin writes, and termination all queue behind the publishing
 * round-trip — the same asynchronous-startup shape the E2B provider documents.
 *
 * @module @deepseek-ai/dsh-subprocess-connector
 */

import { Buffer } from 'node:buffer'
import { PassThrough, Writable } from 'node:stream'
import type { Readable } from 'node:stream'
import { Context } from '@deepseek-ai/cordis'
import { ConnectorError } from '@deepseek-ai/dsh-connector'
import type { ConnectorLink, ConnectorProcessHandle, ConnectorRequest } from '@deepseek-ai/dsh-connector'
import { SubprocessRuntime } from '@deepseek-ai/dsh-subprocess'
import type {
  SubprocessCollectedOutputs,
  SubprocessHandle,
  SubprocessOutcome,
  SubprocessOutputMode,
  SubprocessSpawnSpec,
  SubprocessTerminalHandle,
  SubprocessTerminalSpawnSpec,
} from '@deepseek-ai/dsh-subprocess'
import { ConnectorOutputCollector } from './collect.ts'

/** Stdin that accepts writes before the remote process has been published. */
class DeferredStdin extends Writable {
  constructor(private readonly published: Promise<ConnectorProcessHandle>) {
    super()
  }

  override _write(chunk: Buffer, _encoding: BufferEncoding, callback: (error?: Error | null) => void): void {
    void this.published
      .then(async handle => handle.write(Buffer.from(chunk).toString('base64')))
      .then(() => { callback() }, (error: unknown) => { callback(error as Error) })
  }

  override _final(callback: (error?: Error | null) => void): void {
    void this.published
      .then(async handle => handle.closeStdin())
      .then(() => { callback() }, (error: unknown) => { callback(error as Error) })
  }
}

/** Where one delivered output stream's bytes go on this side of the link. */
interface StreamSink {
  /** The raw readable handed to the caller, for `pipe` mode. */
  readable?: PassThrough
  /** The bounded collector, for a collect mode. */
  collector?: ConnectorOutputCollector
  /** The harness descriptor the bytes are forwarded to, for `inherit` mode. */
  inherit?: NodeJS.WriteStream
}

/** Build the local destination one delivered stream's bytes are routed to. */
function createSink(mode: SubprocessOutputMode, inherited: NodeJS.WriteStream): StreamSink {
  if (mode === 'pipe') return { readable: new PassThrough() }
  if (mode === 'inherit') return { inherit: inherited }
  return { collector: new ConnectorOutputCollector(mode.maxBytes) }
}

/** One connector-backed process projected onto the subprocess seam. */
class ConnectorSubprocessHandle implements SubprocessHandle {
  private remotePid = -1
  private exited = false
  private gone = false
  private readonly goneWaiters = new Set<() => void>()
  private settleDone!: (outcome: SubprocessOutcome) => void
  private failDone!: (error: unknown) => void
  private readonly published: Promise<ConnectorProcessHandle>
  private readonly sinks: { stdout: StreamSink; stderr: StreamSink }

  readonly stdin: Writable | undefined
  readonly done: Promise<SubprocessOutcome>

  constructor(link: Promise<ConnectorLink>, spec: SubprocessSpawnSpec) {
    this.done = new Promise<SubprocessOutcome>((resolve, reject) => {
      this.settleDone = resolve
      this.failDone = reject
    })
    this.sinks = {
      stdout: createSink(spec.stdio.stdout, process.stdout),
      stderr: createSink(spec.stdio.stderr, process.stderr),
    }
    this.published = link.then(async opened => opened.processes.spawn({
      argv: spec.argv,
      cwd: spec.cwd,
      graceMs: spec.graceMs,
      stdin: typeof spec.stdio.stdin === 'object'
        ? { base64: Buffer.from(spec.stdio.stdin.data, 'utf8').toString('base64') }
        : spec.stdio.stdin,
      ...(spec.env === undefined ? {} : { env: stringEnv(spec.env) }),
    }, {
      data: (stream, base64) => { this.deliver(stream, Buffer.from(base64, 'base64')) },
      exit: (outcome) => {
        this.exited = true
        this.endStreams()
        this.settleDone(outcome)
      },
      failed: (message) => {
        const error = new ConnectorError(message, 'CONNECTOR_UNAVAILABLE')
        this.endStreams()
        if (!this.exited) this.failDone(error)
        this.releaseGone()
      },
      gone: () => { this.releaseGone() },
    }))
    this.stdin = spec.stdio.stdin === 'pipe' ? new DeferredStdin(this.published) : undefined
    this.published.then(
      (handle) => { this.remotePid = handle.pid },
      (error: unknown) => {
        this.endStreams()
        this.failDone(error)
        this.releaseGone()
      },
    )
    if (spec.signal !== undefined) {
      if (spec.signal.aborted) this.terminate()
      else spec.signal.addEventListener('abort', () => { this.terminate() }, { once: true })
    }
  }

  get pid(): number {
    return this.remotePid
  }

  get stdout(): Readable | undefined {
    return this.sinks.stdout.readable
  }

  get stderr(): Readable | undefined {
    return this.sinks.stderr.readable
  }

  get collected(): SubprocessCollectedOutputs {
    return {
      ...(this.sinks.stdout.collector === undefined ? {} : { stdout: this.sinks.stdout.collector }),
      ...(this.sinks.stderr.collector === undefined ? {} : { stderr: this.sinks.stderr.collector }),
    }
  }

  terminate(): void {
    void this.published.then(async handle => handle.terminate()).catch(() => undefined)
  }

  async waitForExit(signal?: AbortSignal): Promise<boolean> {
    if (this.gone) return true
    if (signal?.aborted === true) return false
    return new Promise<boolean>((resolve) => {
      const release = (): void => {
        this.goneWaiters.delete(release)
        signal?.removeEventListener('abort', abort)
        resolve(true)
      }
      const abort = (): void => {
        this.goneWaiters.delete(release)
        resolve(false)
      }
      this.goneWaiters.add(release)
      signal?.addEventListener('abort', abort, { once: true })
    })
  }

  private deliver(stream: 'stdout' | 'stderr', chunk: Buffer): void {
    const sink = this.sinks[stream]
    sink.readable?.write(chunk)
    sink.collector?.append(chunk)
    sink.inherit?.write(chunk)
  }

  private endStreams(): void {
    this.sinks.stdout.readable?.end()
    this.sinks.stderr.readable?.end()
  }

  private releaseGone(): void {
    this.gone = true
    for (const release of [...this.goneWaiters]) release()
  }
}

/** Drop tombstoned entries: the wire carries only concrete environment values. */
function stringEnv(env: NodeJS.ProcessEnv): Record<string, string> {
  const entries: Record<string, string> = {}
  for (const [key, value] of Object.entries(env)) {
    if (value !== undefined) entries[key] = value
  }
  return entries
}

/** Connector-backed subprocess provider. */
export class ConnectorSubprocessRuntime extends SubprocessRuntime {
  static inject = ['connectors']

  /** Links opened for spawns whose caller has not settled yet. */
  private readonly live = new Set<ConnectorSubprocessHandle>()

  constructor(ctx: Context) {
    super(ctx)
    ctx.effect(() => async () => {
      const pending = [...this.live].map(async (handle) => {
        handle.terminate()
        await handle.done.catch(() => undefined)
        await handle.waitForExit()
      })
      this.live.clear()
      await Promise.all(pending)
    }, 'connector subprocess teardown')
  }

  override async resolveExecutable(
    command: string,
    env?: Readonly<Record<string, string>>,
    signal?: AbortSignal,
  ): Promise<string> {
    if (command.length === 0) throw new Error('subprocess-connector: executable must be non-empty')
    const link = await this.ctx.connectors.link(currentRequest(this.ctx))
    return link.processes.resolveExecutable(command, env, signal)
  }

  override spawn(spec: SubprocessSpawnSpec): SubprocessHandle {
    // The seam publishes synchronously; the link may still be opening, so the
    // handle owns the round-trip and reports a failed open through `done`.
    const handle = new ConnectorSubprocessHandle(this.ctx.connectors.link(currentRequest(this.ctx)), spec)
    this.live.add(handle)
    const release = (): void => { this.live.delete(handle) }
    handle.done.then(async () => handle.waitForExit(), () => undefined).then(release, release)
    return handle
  }

  override spawnTerminal(_spec: SubprocessTerminalSpawnSpec): Promise<SubprocessTerminalHandle> {
    return Promise.reject(new ConnectorError(
      'connector links do not allocate terminals; mount a persistent-shell capability only on a same-host subprocess provider',
      'CONNECTOR_UNSUPPORTED',
    ))
  }
}

/**
 * The connector-selection inputs for the operation running right now. The
 * calling session comes from the initiating-agent scope, which is the only
 * ambient carrier the subprocess seam exposes — its methods take specs, not
 * sessions. An operation outside any agent resolves the deployment default.
 * @param ctx - context carrying the optional agent registry.
 * @returns the selection request for this call.
 */
export function currentRequest(ctx: Context): ConnectorRequest {
  const session = ctx.get('agents')?.currentInitiator()?.session
  return session === undefined ? {} : { session }
}

export { ConnectorOutputCollector } from './collect.ts'
export default ConnectorSubprocessRuntime
