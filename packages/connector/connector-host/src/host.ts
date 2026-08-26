/**
 * The target-side execution world one connector exposes. It is a private
 * Cordis application holding nothing but `@deepseek-ai/dsh-fs-local` and
 * `@deepseek-ai/dsh-subprocess-local`, projected onto the connector operation
 * set. Reusing the shipped local providers is the point: filesystem identity,
 * atomic publication, line-ending handling, process trees, PATH lookup, and
 * Windows process termination keep exactly one implementation whether the
 * agent runs beside the harness or on another machine.
 * @module @deepseek-ai/dsh-connector-host/host
 */

import { Buffer } from 'node:buffer'
import { finished } from 'node:stream/promises'
import { Context } from '@deepseek-ai/cordis'
import { ConnectorId } from '@deepseek-ai/dsh-connector'
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
import { FsTargetKey } from '@deepseek-ai/dsh-fs'
import type { FsDirEntry, FsInfo, FsPathInfo, FsTarget, FsWriteOutcome, FsEditOutcome } from '@deepseek-ai/dsh-fs'
import { LocalFileSystem } from '@deepseek-ai/dsh-fs-local'
import { LocalSubprocessRuntime } from '@deepseek-ai/dsh-subprocess-local'
import type { SubprocessHandle, SubprocessStdinMode } from '@deepseek-ai/dsh-subprocess'

/** How a connector host presents this machine to its clients. */
export interface ConnectorHostOptions {
  /** Identifier the host reports; the client's own configuration may differ. */
  id?: string
  /** Absolute default working directory for relative paths and spawns. */
  workdir: string
}

/**
 * The connector OS family one Node platform belongs to. Every platform outside
 * the two named families is served by the POSIX path dialect and tooling.
 * @param platform - the platform to classify; defaults to this process's.
 * @returns the connector OS family clients see in the handshake.
 */
export function hostConnectorOs(platform: NodeJS.Platform = process.platform): ConnectorOs {
  if (platform === 'win32') return 'windows'
  return platform === 'darwin' ? 'macos' : 'linux'
}

/** Rebuild the `FsTarget` a local filesystem operation expects from wire fields. */
function asTarget(targetKey: string, displayPath: string): FsTarget {
  return { targetKey: FsTargetKey(targetKey), displayPath }
}

/** Project a local directory entry onto its JSON-encodable wire form. */
function wireEntry(entry: FsDirEntry): FsDirEntry {
  return {
    name: entry.name,
    type: entry.type,
    target: { targetKey: entry.target.targetKey, displayPath: entry.target.displayPath },
    ...(entry.version === undefined ? {} : { version: entry.version }),
    ...(entry.size === undefined ? {} : { size: entry.size }),
  }
}

/** Translate the wire stdin disposition into the local subprocess seam's. */
function localStdin(stdin: ConnectorSpawnSpec['stdin']): SubprocessStdinMode {
  if (stdin === 'ignore' || stdin === 'pipe') return stdin
  return { data: Buffer.from(stdin.base64, 'base64').toString('utf8') }
}

/**
 * Resolve once the stream has delivered its last chunk. `finished` also
 * answers for a stream that already ended, which the ordinary case is: `done`
 * settles on the child's `close`, after both pipes are finished.
 */
async function whenEnded(handle: SubprocessHandle, stream: 'stdout' | 'stderr'): Promise<void> {
  const readable = handle[stream]
  // The host always spawns both output streams piped and owns the readables it gets back, so
  // neither an absent stream nor a premature destroy is reachable from a client.
  /* v8 ignore next */
  if (readable === undefined) return
  /* v8 ignore next */
  await finished(readable).catch(() => undefined)
}

/** Filesystem operations backed by the private local provider. */
class HostFileOperations implements ConnectorFileOperations {
  constructor(private readonly fs: LocalFileSystem) {}

  async resolve(path: string, cwd: string | undefined, signal: AbortSignal | undefined): Promise<ConnectorTarget> {
    const target = await this.fs.resolve(path, { ...(cwd === undefined ? {} : { cwd }), ...(signal === undefined ? {} : { signal }) })
    return { targetKey: String(target.targetKey), displayPath: target.displayPath }
  }

  async stat(targetKey: string, signal: AbortSignal | undefined): Promise<FsInfo | undefined> {
    return this.fs.stat(asTarget(targetKey, targetKey), signal)
  }

  async lstat(path: string, cwd: string | undefined, signal: AbortSignal | undefined): Promise<FsPathInfo | undefined> {
    return this.fs.lstat(path, cwd === undefined ? undefined : { cwd }, signal)
  }

  async readText(targetKey: string, displayPath: string, signal: AbortSignal | undefined): Promise<string> {
    return this.fs.readText(asTarget(targetKey, displayPath), signal)
  }

  async readBytesBase64(
    targetKey: string,
    displayPath: string,
    maxBytes: number,
    signal: AbortSignal | undefined,
  ): Promise<string> {
    const bytes = await this.fs.readBytes(asTarget(targetKey, displayPath), signal, maxBytes)
    return Buffer.from(bytes).toString('base64')
  }

  async listDir(targetKey: string, displayPath: string, signal: AbortSignal | undefined): Promise<FsDirEntry[]> {
    const entries = await this.fs.listDir(asTarget(targetKey, displayPath), signal)
    return entries.map(wireEntry)
  }

  async writeText(request: ConnectorWriteRequest, signal: AbortSignal | undefined): Promise<FsWriteOutcome> {
    return this.fs.writeText(
      asTarget(request.targetKey, request.displayPath),
      request.content,
      request.expected,
      signal,
    )
  }

  async editText(request: ConnectorEditRequest, signal: AbortSignal | undefined): Promise<FsEditOutcome> {
    return this.fs.editText(
      asTarget(request.targetKey, request.displayPath),
      request.edit,
      request.expected,
      signal,
    )
  }
}

/** One running local process projected onto the connector process contract. */
class HostProcessHandle implements ConnectorProcessHandle {
  constructor(private readonly handle: SubprocessHandle) {}

  get pid(): number {
    return this.handle.pid
  }

  write(base64: string): Promise<void> {
    const stdin = this.handle.stdin
    if (stdin === undefined) throw new Error('connector-host: this process was not spawned with a stdin pipe')
    return new Promise<void>((resolve, reject) => {
      stdin.write(Buffer.from(base64, 'base64'), (error) => {
        if (error === null || error === undefined) resolve()
        else reject(error)
      })
    })
  }

  closeStdin(): Promise<void> {
    const stdin = this.handle.stdin
    if (stdin === undefined || stdin.writableEnded) return Promise.resolve()
    return new Promise<void>((resolve) => { stdin.end(resolve) })
  }

  terminate(): Promise<void> {
    this.handle.terminate()
    return Promise.resolve()
  }
}

/** Process operations backed by the private local provider. */
class HostProcessOperations implements ConnectorProcessOperations {
  constructor(private readonly subprocess: LocalSubprocessRuntime) {}

  async resolveExecutable(
    command: string,
    env: Readonly<Record<string, string>> | undefined,
    signal: AbortSignal | undefined,
  ): Promise<string> {
    return this.subprocess.resolveExecutable(command, env, signal)
  }

  async spawn(spec: ConnectorSpawnSpec, events: ConnectorProcessEvents): Promise<ConnectorProcessHandle> {
    const handle = this.subprocess.spawn({
      argv: spec.argv,
      cwd: spec.cwd,
      graceMs: spec.graceMs,
      stdio: { stdin: localStdin(spec.stdin), stdout: 'pipe', stderr: 'pipe' },
      ...(spec.env === undefined ? {} : { env: { ...spec.env } }),
    })
    // A child that exits while stdin still holds queued bytes makes that pipe
    // emit EPIPE. The pending write's own callback reports it to the caller
    // that asked for the write; without this listener the same error would
    // also reach the agent process as an unhandled stream error.
    handle.stdin?.on('error', () => undefined)
    handle.stdout?.on('data', (chunk: Buffer) => { events.data('stdout', chunk.toString('base64')) })
    handle.stderr?.on('data', (chunk: Buffer) => { events.data('stderr', chunk.toString('base64')) })
    // Exit is announced only once both piped streams are finished, so a client
    // never observes the outcome before the output that preceded it.
    void handle.done.then(
      async (outcome) => {
        await Promise.all([whenEnded(handle, 'stdout'), whenEnded(handle, 'stderr')])
        events.exit(outcome)
        await handle.waitForExit()
        events.gone()
      },
      (error: unknown) => { events.failed(String(error)) },
    )
    return Promise.resolve(new HostProcessHandle(handle))
  }
}

/**
 * Build the execution world one connector agent serves.
 * @param options - the reported identifier and the absolute default workdir.
 * @returns a link over this machine's filesystem and processes.
 */
export async function createConnectorHost(options: ConnectorHostOptions): Promise<ConnectorLink> {
  const ctx = new Context()
  const fsFiber = await ctx.plugin(LocalFileSystem, { cwd: options.workdir })
  const subprocessFiber = await ctx.plugin(LocalSubprocessRuntime)
  const descriptor: ConnectorDescriptor = {
    id: ConnectorId(options.id ?? 'host'),
    os: hostConnectorOs(),
    workdir: options.workdir,
  }
  let closed = false
  return {
    descriptor,
    files: new HostFileOperations(ctx.fs as LocalFileSystem),
    processes: new HostProcessOperations(ctx.subprocess as LocalSubprocessRuntime),
    async close(): Promise<void> {
      if (closed) return
      closed = true
      await subprocessFiber.dispose()
      await fsFiber.dispose()
    },
  }
}
