/**
 * The connector wire protocol: newline-delimited JSON frames carrying
 * request/response calls plus server-initiated process notifications. TCP was
 * chosen over an HTTP upgrade because it needs no dependency on either side,
 * runs unchanged on Linux and Windows, and tunnels through `ssh -L` without a
 * proxy that understands the payload.
 *
 * Both the connector agent and every client transport decode frames through
 * this module, so the wire contract has one home.
 *
 * @module @deepseek-ai/dsh-connector/protocol
 */

import { ConnectorError } from './types.ts'
import type { ConnectorOs } from './types.ts'

/**
 * Wire-protocol revision. A client and agent that disagree refuse the
 * connection at the handshake instead of failing later inside an operation.
 */
export const CONNECTOR_PROTOCOL_VERSION = 1

/**
 * Inclusive byte ceiling on one encoded frame. It bounds what an unauthenticated
 * peer can make either side buffer before the handshake completes, and it is
 * large enough for a whole-file write of the size the filesystem tools produce.
 */
export const CONNECTOR_MAX_FRAME_BYTES = 64 * 1024 * 1024

/** Opening client frame; the agent answers with `ready` or closes the socket. */
export interface ConnectorHelloFrame {
  t: 'hello'
  /** Protocol revision the client speaks. */
  protocol: number
  /** Shared secret the agent was started with. */
  token: string
}

/** Agent acceptance frame, carrying the facts a client cannot configure itself. */
export interface ConnectorReadyFrame {
  t: 'ready'
  /** Protocol revision the agent speaks. */
  protocol: number
  /** Operating-system family of the agent's execution world. */
  os: ConnectorOs
  /** Absolute default working directory in the agent's execution world. */
  workdir: string
}

/** One client request awaiting exactly one `result` or `error` frame. */
export interface ConnectorCallFrame {
  t: 'call'
  /** Client-assigned correlation id, unique while the call is in flight. */
  id: number
  /** Operation name from the method table this protocol defines. */
  method: string
  /** Positional arguments of the operation. */
  params: readonly unknown[]
}

/** Client request to abort one in-flight call; the call still answers. */
export interface ConnectorCancelFrame {
  t: 'cancel'
  /** Correlation id of the call to abort. */
  id: number
}

/** Successful answer to one call. */
export interface ConnectorResultFrame {
  t: 'result'
  /** Correlation id of the answered call. */
  id: number
  /** The operation's JSON-encodable return value. */
  value: unknown
}

/** Failed answer to one call. */
export interface ConnectorErrorFrame {
  t: 'error'
  /** Correlation id of the answered call. */
  id: number
  /** Reconstructable failure facts. */
  error: ConnectorWireError
}

/**
 * A failure crossing the link. `kind` selects the error class the client
 * rebuilds, so a filesystem denial stays routable by its `FsErrorCode` instead
 * of collapsing into an opaque transport failure.
 */
export interface ConnectorWireError {
  /** Which typed error class the client reconstructs. */
  kind: 'fs' | 'connector' | 'plain'
  /** Stable machine-routable code, for the typed kinds. */
  code?: string
  /** Human-readable failure text. */
  message: string
}

/**
 * Server-initiated notification about one running process. The identifier is
 * assigned by the CLIENT in the `proc.spawn` call, so the client can install
 * its observer before the agent can deliver the first notification.
 */
export interface ConnectorEventFrame {
  t: 'event'
  /** Client-assigned identifier of the process the notification is about. */
  handle: number
  /** Which observation this frame carries. */
  kind: 'data' | 'exit' | 'failed' | 'gone'
  /** Output stream, for `data` frames. */
  stream?: 'stdout' | 'stderr'
  /** Raw output bytes as standard base64, for `data` frames. */
  base64?: string
  /** Exit code, for `exit` frames; null when the process died from a signal. */
  exitCode?: number | null
  /** Terminating signal name, for `exit` frames; null on normal exit. */
  signal?: string | null
  /** Failure text, for `failed` frames. */
  message?: string
}

/** Every frame either peer may send. */
export type ConnectorFrame =
  | ConnectorHelloFrame
  | ConnectorReadyFrame
  | ConnectorCallFrame
  | ConnectorCancelFrame
  | ConnectorResultFrame
  | ConnectorErrorFrame
  | ConnectorEventFrame

/**
 * Encode one frame for the wire.
 * @param frame - the frame to send.
 * @returns the newline-terminated JSON text.
 */
export function encodeFrame(frame: ConnectorFrame): string {
  return `${JSON.stringify(frame)}\n`
}

/**
 * Incremental newline-delimited frame reader. It rejects an over-long line
 * rather than growing without bound, because the peer is remote and may be
 * hostile before the handshake has authenticated it.
 */
export class ConnectorFrameDecoder {
  private buffer = ''

  constructor(private readonly maxBytes: number = CONNECTOR_MAX_FRAME_BYTES) {}

  /**
   * Consume one transport chunk and return every complete frame it finished.
   * @param chunk - UTF-8 text received from the peer.
   * @returns the frames decoded from this chunk, in arrival order.
   */
  push(chunk: string): ConnectorFrame[] {
    this.buffer += chunk
    const frames: ConnectorFrame[] = []
    let newline = this.buffer.indexOf('\n')
    while (newline >= 0) {
      const line = this.buffer.slice(0, newline)
      this.buffer = this.buffer.slice(newline + 1)
      if (line.length > 0) frames.push(decodeFrame(line, this.maxBytes))
      newline = this.buffer.indexOf('\n')
    }
    if (this.buffer.length > this.maxBytes) {
      throw new ConnectorError(
        `connector frame exceeds the ${this.maxBytes}-byte limit`,
        'CONNECTOR_PROTOCOL',
      )
    }
    return frames
  }
}

/** Reject a frame the peer sent that this protocol revision cannot interpret. */
function protocolFailure(detail: string): ConnectorError {
  return new ConnectorError(`connector protocol violation: ${detail}`, 'CONNECTOR_PROTOCOL')
}

/**
 * Decode and validate one wire line.
 * @param line - the JSON text of one frame, without its newline.
 * @param maxBytes - inclusive byte ceiling the line must respect.
 * @returns the validated frame.
 */
export function decodeFrame(line: string, maxBytes: number = CONNECTOR_MAX_FRAME_BYTES): ConnectorFrame {
  if (line.length > maxBytes) throw protocolFailure(`frame exceeds the ${maxBytes}-byte limit`)
  let parsed: unknown
  try {
    parsed = JSON.parse(line)
  } catch (error: unknown) {
    throw protocolFailure(`frame is not valid JSON: ${String(error)}`)
  }
  if (typeof parsed !== 'object' || parsed === null) throw protocolFailure('frame is not an object')
  const frame = parsed as Partial<ConnectorFrame> & { t?: unknown }
  switch (frame.t) {
    case 'hello':
      return requireFields(frame, ['protocol', 'token'])
    case 'ready':
      return requireFields(frame, ['protocol', 'os', 'workdir'])
    case 'call':
      if (!Array.isArray((frame as ConnectorCallFrame).params)) throw protocolFailure('call frame has no params array')
      return requireFields(frame, ['id', 'method'])
    case 'cancel':
      return requireFields(frame, ['id'])
    case 'result':
      return requireFields(frame, ['id'])
    case 'error':
      return requireFields(frame, ['id', 'error'])
    case 'event':
      return requireFields(frame, ['handle', 'kind'])
    default:
      throw protocolFailure(`unknown frame type ${JSON.stringify(String(frame.t))}`)
  }
}

/** Require every named field to be present on a frame whose tag already matched. */
function requireFields<T extends ConnectorFrame>(frame: object, fields: readonly string[]): T {
  for (const field of fields) {
    if (!(field in frame)) throw protocolFailure(`frame is missing "${field}"`)
  }
  return frame as T
}
