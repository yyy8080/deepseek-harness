/**
 * Vocabulary for the connector Service Definition (`ctx.connectors`): connector identity and
 * target-OS profile, the wire-neutral operation set a connector performs
 * inside its own execution world, and the typed error taxonomy shared by every
 * transport.
 * @module @deepseek-ai/dsh-connector/types
 */

import { HarnessError } from '@deepseek-ai/dsh-llm'
import type { Branded } from '@deepseek-ai/dsh-brand'
import type {
  FsDirEntry,
  FsEditOutcome,
  FsEditRequest,
  FsInfo,
  FsPathInfo,
  FsVersion,
  FsWriteIntent,
  FsWriteOutcome,
} from '@deepseek-ai/dsh-fs'
import type { SubprocessOutcome } from '@deepseek-ai/dsh-subprocess'

/**
 * Opaque identifier of one configured connector. Deployments choose the
 * string; sessions and tool output carry it, so consumers must not parse it.
 */
export type ConnectorId = Branded<'ConnectorId'>

/**
 * Brand a configured string as a {@link ConnectorId}.
 * @param id - the deployment-chosen connector name.
 * @returns the same string, branded; no validation is performed.
 */
export function ConnectorId(id: string): ConnectorId {
  return id as ConnectorId
}

/**
 * Operating-system family of a connector's execution world. It selects the
 * path dialect (`win32` for `windows`, `posix` otherwise) every synchronous
 * path computation in a connector-backed filesystem provider uses, so it is a
 * required part of a connector declaration rather than something discovered
 * per call.
 */
export type ConnectorOs = 'linux' | 'macos' | 'windows'

/** Static facts a connector publishes before its first operation runs. */
export interface ConnectorDescriptor {
  /** Deployment-chosen identifier sessions bind to. */
  id: ConnectorId
  /** Target-OS family, which fixes the path dialect of every returned path. */
  os: ConnectorOs
  /**
   * Absolute directory in the target world that relative paths and default
   * spawns resolve against.
   */
  workdir: string
}

/** A path resolved inside a connector's execution world. */
export interface ConnectorTarget {
  /** Canonical absolute path in the target world; also the opaque `FsTargetKey`. */
  targetKey: string
  /** Path for model- and user-facing output. */
  displayPath: string
}

/** A guarded whole-file write crossing the connector link. */
export interface ConnectorWriteRequest {
  /** Canonical absolute path in the target world. */
  targetKey: string
  /** Path used in error text. */
  displayPath: string
  /** Full new file content. */
  content: string
  /** Write intent guarding the write; omit for unconditional create-or-overwrite. */
  expected?: FsWriteIntent
}

/** A guarded literal edit crossing the connector link. */
export interface ConnectorEditRequest {
  /** Canonical absolute path in the target world. */
  targetKey: string
  /** Path used in error text. */
  displayPath: string
  /** Literal search/replace request. */
  edit: FsEditRequest
  /** Version guard; omit for an unconditional edit. */
  expected?: { version: FsVersion }
}

/**
 * Filesystem operations a connector performs in its own execution world. Every
 * method mirrors the corresponding `ctx.fs` operation minus the parts a
 * consumer can compute locally from a path and the connector's
 * {@link ConnectorOs}: `processPath`, `fileUrl`, and `contains` never cross the
 * link.
 */
export interface ConnectorFileOperations {
  /**
   * Resolve a path into a canonical target in the connector's world.
   * @param path - path to resolve; relative paths use `cwd` or the connector workdir.
   * @param cwd - base directory for a relative path.
   * @param signal - aborts the round-trip.
   * @returns the canonical target.
   */
  resolve(path: string, cwd: string | undefined, signal: AbortSignal | undefined): Promise<ConnectorTarget>
  /**
   * Return target metadata.
   * @param targetKey - canonical absolute path in the target world.
   * @param signal - aborts the round-trip.
   * @returns metadata, or undefined when the target is absent.
   */
  stat(targetKey: string, signal: AbortSignal | undefined): Promise<FsInfo | undefined>
  /**
   * Return path metadata without following a final symbolic link.
   * @param path - path to inspect.
   * @param cwd - base directory for a relative path.
   * @param signal - aborts the round-trip.
   * @returns metadata, or undefined when the path is absent.
   */
  lstat(path: string, cwd: string | undefined, signal: AbortSignal | undefined): Promise<FsPathInfo | undefined>
  /**
   * Read a whole regular text file.
   * @param targetKey - canonical absolute path in the target world.
   * @param displayPath - path used in error text.
   * @param signal - aborts the round-trip.
   * @returns the full decoded UTF-8 content.
   */
  readText(targetKey: string, displayPath: string, signal: AbortSignal | undefined): Promise<string>
  /**
   * Read a whole regular file as raw bytes, capped at `maxBytes`.
   * @param targetKey - canonical absolute path in the target world.
   * @param displayPath - path used in error text.
   * @param maxBytes - inclusive byte cap on the complete content.
   * @param signal - aborts the round-trip.
   * @returns the complete content as a standard base64 string.
   */
  readBytesBase64(
    targetKey: string,
    displayPath: string,
    maxBytes: number,
    signal: AbortSignal | undefined,
  ): Promise<string>
  /**
   * List the direct children of a directory in stable name order.
   * @param targetKey - canonical absolute directory path in the target world.
   * @param displayPath - path used in error text.
   * @param signal - aborts the round-trip.
   * @returns one entry per direct child.
   */
  listDir(targetKey: string, displayPath: string, signal: AbortSignal | undefined): Promise<FsDirEntry[]>
  /**
   * Atomically create or replace UTF-8 text.
   * @param request - target, content, and optional write intent.
   * @param signal - aborts before atomic publication takes effect.
   * @returns the outcome, including the version the write produced.
   */
  writeText(request: ConnectorWriteRequest, signal: AbortSignal | undefined): Promise<FsWriteOutcome>
  /**
   * Atomically apply a literal edit.
   * @param request - target, literal edit, and optional version guard.
   * @param signal - aborts before atomic publication takes effect.
   * @returns the outcome, including the version the edit produced.
   */
  editText(request: ConnectorEditRequest, signal: AbortSignal | undefined): Promise<FsEditOutcome>
}

/**
 * A fully-specified spawn crossing the connector link. Both output streams are
 * always delivered: collection limits, spill, truncation, and pass-through to
 * the harness's own descriptors are consumer decisions that need the bytes
 * either way.
 */
export interface ConnectorSpawnSpec {
  /** Executable and arguments; `argv[0]` is the program. Never shell-interpreted. */
  argv: readonly string[]
  /** Working directory in the target world. */
  cwd: string
  /** Whether stdin is a live pipe, closed immediately, or pre-filled and closed. */
  stdin: 'ignore' | 'pipe' | { readonly base64: string }
  /** Positive grace period in milliseconds for the terminate escalation. */
  graceMs: number
  /** Explicit environment entries merged onto the target's scrubbed parent base. */
  env?: Readonly<Record<string, string>>
}

/** Callbacks a connector invokes for one running process, in delivery order. */
export interface ConnectorProcessEvents {
  /**
   * Deliver output bytes captured from one stream.
   * @param stream - which of the child's output streams produced the bytes.
   * @param base64 - the raw bytes, standard base64.
   */
  data(stream: 'stdout' | 'stderr', base64: string): void
  /**
   * Report process close. Invoked at most once, after the final `data` call.
   * @param outcome - exit code and terminating signal.
   */
  exit(outcome: SubprocessOutcome): void
  /**
   * Report a failure that ends observation before any outcome: the spawn never
   * started, or the transport was lost while the process was still running.
   * Mutually exclusive with `exit` — a transport lost AFTER the outcome
   * arrived reports `gone` instead, because the outcome is already known.
   * @param message - human-readable failure text.
   */
  failed(message: string): void
  /** Report that the whole process tree has exited. Invoked at most once, after `exit`. */
  gone(): void
}

/** Control interface for one process running in a connector's execution world. */
export interface ConnectorProcessHandle {
  /** Process id of the tree root in the target world. */
  readonly pid: number
  /**
   * Write bytes to the child's stdin. Rejects when the spec did not request a
   * live stdin pipe or the stream is already closed.
   * @param base64 - the bytes to write, standard base64.
   */
  write(base64: string): Promise<void>
  /** Close the child's stdin. Idempotent, and a no-op without a live pipe. */
  closeStdin(): Promise<void>
  /**
   * Begin the tree-scoped SIGTERM/grace/SIGKILL escalation. Idempotent, and
   * never rejects: a process the target already reaped, and a link that has
   * since dropped, both leave nothing for a caller to do about it.
   */
  terminate(): Promise<void>
}

/** Process operations a connector performs in its own execution world. */
export interface ConnectorProcessOperations {
  /**
   * Resolve one executable in the connector's execution world.
   * @param command - absolute executable path or bare PATH name.
   * @param env - explicit environment entries used for lookup.
   * @param signal - aborts the round-trip.
   * @returns a canonical executable path in the target world.
   */
  resolveExecutable(
    command: string,
    env: Readonly<Record<string, string>> | undefined,
    signal: AbortSignal | undefined,
  ): Promise<string>
  /**
   * Start one managed process tree in the connector's execution world.
   * @param spec - argv, directory, stream dispositions, grace, and environment.
   * @param events - callbacks receiving output, close, failure, and tree-exit facts.
   * @returns the control handle, after the process has a pid.
   */
  spawn(spec: ConnectorSpawnSpec, events: ConnectorProcessEvents): Promise<ConnectorProcessHandle>
}

/**
 * One live connection to a connector's execution world. Opening is the
 * registry's job; a link is shared by every consumer bound to that connector
 * and closed exactly once when the registry disposes.
 */
export interface ConnectorLink {
  /** The connector this link reaches. */
  readonly descriptor: ConnectorDescriptor
  /** Filesystem operations in the target world. */
  readonly files: ConnectorFileOperations
  /** Process operations in the target world. */
  readonly processes: ConnectorProcessOperations
  /** Release the transport and every resource it still owns. Idempotent. */
  close(): Promise<void>
}

/**
 * Open one live link to a connector. The registry calls it at most once per
 * connector and memoizes the result.
 * @returns the opened link.
 */
export type ConnectorOpener = () => Promise<ConnectorLink>

/**
 * Stable, machine-routable codes for connector failures. Carried on
 * {@link ConnectorError}.
 */
export type ConnectorErrorCode =
  | 'CONNECTOR_UNKNOWN'
  | 'CONNECTOR_UNAVAILABLE'
  | 'CONNECTOR_PROTOCOL'
  | 'CONNECTOR_UNSUPPORTED'

/**
 * Typed connector failure. `CONNECTOR_UNKNOWN` names a connector id no
 * registration answers, `CONNECTOR_UNAVAILABLE` a link that cannot be opened or
 * has been lost, `CONNECTOR_PROTOCOL` a peer that violated the wire contract,
 * and `CONNECTOR_UNSUPPORTED` an operation the target world cannot perform.
 */
export class ConnectorError extends HarnessError {
  override readonly code: ConnectorErrorCode

  constructor(message: string, code: ConnectorErrorCode, options?: ErrorOptions) {
    super(message, code, options)
    this.code = code
  }
}
