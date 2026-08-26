/**
 * Connector-backed implementation of `ctx.fs`. Every operation runs on the
 * machine the calling session is bound to; the harness process holds only the
 * request and its result.
 *
 * Path facts are computed in the TARGET's dialect, never the harness host's:
 * the connector descriptor's OS family selects `posix` or `win32` for process
 * paths, `file:` URIs, and containment, so a Linux harness can drive a Windows
 * target without the two disagreeing about what a path means.
 *
 * @module @deepseek-ai/dsh-fs-connector
 */

import { Buffer } from 'node:buffer'
import { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-agent'
import { connectorPathModule } from '@deepseek-ai/dsh-connector'
import type { ConnectorDescriptor, ConnectorLink, ConnectorOs, ConnectorRequest } from '@deepseek-ai/dsh-connector'
import { FileSystem, FsError, FsTargetKey } from '@deepseek-ai/dsh-fs'
import type {
  FsDirEntry,
  FsEditOutcome,
  FsEditRequest,
  FsInfo,
  FsPathInfo,
  FsTarget,
  FsVersion,
  FsWriteIntent,
  FsWriteOutcome,
} from '@deepseek-ai/dsh-fs'

/**
 * Percent-encode the characters a `file:` URI cannot carry literally. Node's
 * `pathToFileURL` is unusable here because it always encodes for the HOST
 * platform, while these paths belong to the target's world.
 */
function encodePathForUrl(path: string): string {
  return path
    .replaceAll('%', '%25')
    .replaceAll('#', '%23')
    .replaceAll('?', '%3F')
    .replaceAll('\n', '%0A')
    .replaceAll('\r', '%0D')
    .replaceAll('\t', '%09')
}

/**
 * The canonical `file:` URI of an absolute path in a connector's world.
 * @param os - the target's OS family, which fixes the separator and root form.
 * @param path - an absolute path in the target's world.
 * @returns the target-dialect file URI.
 */
export function connectorFileUrl(os: ConnectorOs, path: string): string {
  if (os !== 'windows') return `file://${encodePathForUrl(path)}`
  const slashed = path.replaceAll('\\', '/')
  // A UNC path is already rooted at its host component; a drive path needs the
  // empty authority that `file:///C:/…` carries.
  return slashed.startsWith('//') ? `file:${encodePathForUrl(slashed)}` : `file:///${encodePathForUrl(slashed)}`
}

/** Connector-backed filesystem provider. */
export class ConnectorFileSystem extends FileSystem {
  static inject = ['connectors']

  override async resolve(path: string, opts?: { cwd?: string; signal?: AbortSignal }): Promise<FsTarget> {
    if (opts?.signal?.aborted === true) throw new FsError('resolve aborted', 'FS_ABORTED')
    if (path.trim().length === 0) throw new FsError('file_path must be a non-empty string', 'FS_NOT_FOUND')
    const link = await this.link()
    const target = await link.files.resolve(path, opts?.cwd, opts?.signal)
    return { targetKey: FsTargetKey(target.targetKey), displayPath: target.displayPath }
  }

  override processPath(target: FsTarget): string {
    return String(target.targetKey)
  }

  override fileUrl(target: FsTarget): string {
    return connectorFileUrl(this.descriptor().os, this.processPath(target))
  }

  override contains(parent: FsTarget, child: FsTarget): boolean {
    const path = connectorPathModule(this.descriptor().os)
    const relative = path.relative(this.processPath(parent), this.processPath(child))
    return relative === ''
      || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))
  }

  override async stat(target: FsTarget, signal?: AbortSignal): Promise<FsInfo | undefined> {
    const link = await this.link()
    return link.files.stat(this.processPath(target), signal)
  }

  override async lstat(path: string, opts?: { cwd?: string }, signal?: AbortSignal): Promise<FsPathInfo | undefined> {
    if (path.trim().length === 0) throw new FsError('file_path must be a non-empty string', 'FS_NOT_FOUND')
    const link = await this.link()
    return link.files.lstat(path, opts?.cwd, signal)
  }

  override async readText(target: FsTarget, signal?: AbortSignal): Promise<string> {
    const link = await this.link()
    return link.files.readText(this.processPath(target), target.displayPath, signal)
  }

  override async streamText(target: FsTarget, signal?: AbortSignal): Promise<AsyncIterable<string>> {
    // The link answers a whole-file read in one frame, so the stream is one
    // chunk. Consumers keep their incremental interface; the transfer is not
    // incremental. See this package's Known Limitations.
    const text = await this.readText(target, signal)
    return {
      // oxlint-disable-next-line typescript/require-await -- the async generator protocol requires the async form.
      async *[Symbol.asyncIterator](): AsyncGenerator<string> {
        if (text.length > 0) yield text
      },
    }
  }

  override async readBytes(target: FsTarget, signal: AbortSignal | undefined, maxBytes: number): Promise<Uint8Array> {
    const link = await this.link()
    const base64 = await link.files.readBytesBase64(this.processPath(target), target.displayPath, maxBytes, signal)
    return Uint8Array.from(Buffer.from(base64, 'base64'))
  }

  override async listDir(target: FsTarget, signal?: AbortSignal): Promise<FsDirEntry[]> {
    const link = await this.link()
    return link.files.listDir(this.processPath(target), target.displayPath, signal)
  }

  override async writeText(
    target: FsTarget,
    content: string,
    expected?: FsWriteIntent,
    signal?: AbortSignal,
  ): Promise<FsWriteOutcome> {
    const link = await this.link()
    return link.files.writeText({
      targetKey: this.processPath(target),
      displayPath: target.displayPath,
      content,
      ...(expected === undefined ? {} : { expected }),
    }, signal)
  }

  override async editText(
    target: FsTarget,
    edit: FsEditRequest,
    expected?: { version: FsVersion },
    signal?: AbortSignal,
  ): Promise<FsEditOutcome> {
    const link = await this.link()
    return link.files.editText({
      targetKey: this.processPath(target),
      displayPath: target.displayPath,
      edit,
      ...(expected === undefined ? {} : { expected }),
    }, signal)
  }

  /** The connector every operation in the calling session runs against. */
  private descriptor(): ConnectorDescriptor {
    return this.ctx.connectors.describe(currentRequest(this.ctx))
  }

  private async link(): Promise<ConnectorLink> {
    return this.ctx.connectors.link(currentRequest(this.ctx))
  }
}

/**
 * The connector-selection inputs for the operation running right now. The
 * calling session comes from the initiating-agent scope, which is the only
 * ambient carrier the filesystem seam exposes — its methods take targets, not
 * sessions. An operation outside any agent (a diagnostic or a bare composition
 * test) resolves the deployment default instead.
 * @param ctx - context carrying the optional agent registry.
 * @returns the selection request for this call.
 */
export function currentRequest(ctx: Context): ConnectorRequest {
  const session = ctx.get('agents')?.currentInitiator()?.session
  return session === undefined ? {} : { session }
}

export default ConnectorFileSystem
