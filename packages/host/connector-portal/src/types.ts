/** Wire vocabulary of the connector portal: enrollments, packs, and attached targets. */

import type { Branded } from '@deepseek-ai/dsh-brand'

/**
 * Opaque identity of one enrollment. It is also the unguessable path segment
 * of that enrollment's pack download, so possession of the id is what
 * authorizes the download.
 */
export type ConnectorEnrollmentId = Branded<'ConnectorEnrollmentId'>

/** Target families the portal packages a connector for. */
export type ConnectorPackOs = 'linux' | 'macos' | 'windows'

/** What the browser asks for when a user picks a platform. */
export interface ConnectorPackRequest {
  /** Target family the pack is generated for. */
  readonly os: ConnectorPackOs
}

/** Everything the browser needs to present one freshly issued pack. */
export interface ConnectorPackTicket {
  readonly enrollmentId: ConnectorEnrollmentId
  /** Target family this pack starts an agent on. */
  readonly os: ConnectorPackOs
  /** Origin-relative download path of the start script. */
  readonly downloadPath: string
  /** File name the download is saved under. */
  readonly fileName: string
  /**
   * Origin-relative path of the one-line install command's source. The browser
   * composes the copyable command from it and its own origin.
   */
  readonly installPath: string
  /** Epoch milliseconds after which the download path stops answering. */
  readonly expiresAt: number
}

/** Lifecycle of one enrollment as the portal reports it. */
export type ConnectorEnrollmentStatus = 'issued' | 'downloaded' | 'attached' | 'expired'

/** One enrollment and, once its agent dialled in, the machine behind it. */
export interface ConnectorEnrollmentView {
  readonly enrollmentId: ConnectorEnrollmentId
  /** Connector id a session binds to; equal to the enrollment id. */
  readonly connectorId: string
  /** Target family the pack was generated for. */
  readonly os: ConnectorPackOs
  readonly status: ConnectorEnrollmentStatus
  /** Name the attached agent reported for its machine, or null before it attached. */
  readonly label: string | null
  /** Default working directory the attached agent serves, or null before it attached. */
  readonly workdir: string | null
  /** Epoch milliseconds the enrollment was issued at. */
  readonly issuedAt: number
  /** Epoch milliseconds the pack download stops answering at. */
  readonly expiresAt: number
}

/**
 * Whether this deployment can start a conversation bound to a connector, and
 * with which composition. A binding only reaches the model when the session's
 * agent is composed from a preset that mounts the connector-backed filesystem
 * and subprocess providers; a deployment whose configured preset does neither
 * would run the conversation on the harness machine while the UI claimed
 * otherwise, so the portal reports the refusal instead of offering the action.
 */
export type ConnectorChatAvailability =
  | {
    readonly ready: true
    /** Agent preset a connector conversation is composed from. */
    readonly agentPreset: string
  }
  | {
    readonly ready: false
    /** Machine-routable reason the action is unavailable. */
    readonly reason: ConnectorChatRefusal
    /** Operator-facing text naming what to configure. */
    readonly message: string
  }

/** Why a deployment cannot start connector-bound conversations. */
export type ConnectorChatRefusal =
  /** No agent-preset roster is composed, so no session can name a composition. */
  | 'no-preset-roster'
  /** The configured preset id is absent from the roster. */
  | 'preset-missing'
  /** The configured preset composes no connector-backed execution world. */
  | 'preset-not-connector-backed'

/** Point-in-time view of every enrollment this deployment is holding. */
export interface ConnectorPortalSnapshot {
  readonly enrollments: readonly ConnectorEnrollmentView[]
  /** Whether the browser may offer "start a chat on this machine", and how. */
  readonly chat: ConnectorChatAvailability
}

/** Which attached machine a liveness probe checks. */
export interface ConnectorProbeRequest {
  readonly enrollmentId: ConnectorEnrollmentId
}

/** Why a liveness probe could not complete a round trip. */
export type ConnectorProbeFailure =
  /** No enrollment answers that id — it was revoked, or the harness restarted. */
  | 'unknown-enrollment'
  /** The enrollment exists but no agent is currently connected. */
  | 'not-attached'
  /** An agent holds the connection but the round trip failed or timed out. */
  | 'link-failed'

/**
 * The outcome of one active round trip over a connector's live link. It is
 * never derived from the ledger's `attached` status: that records the last
 * handshake, while this records an operation the target answered just now.
 */
export type ConnectorProbeReport =
  | {
    readonly alive: true
    readonly enrollmentId: ConnectorEnrollmentId
    /** Epoch milliseconds the probe ran at. */
    readonly probedAt: number
    /** Wall-clock milliseconds the round trip took. */
    readonly latencyMs: number
    /** Canonical absolute workdir path the TARGET resolved, in its own dialect. */
    readonly resolvedWorkdir: string
    /** Whether that path is a directory on the target right now. */
    readonly workdirIsDirectory: boolean
  }
  | {
    readonly alive: false
    readonly enrollmentId: ConnectorEnrollmentId
    /** Epoch milliseconds the probe ran at. */
    readonly probedAt: number
    /** Machine-routable failure code. */
    readonly failure: ConnectorProbeFailure
    /** Operator-facing text naming the next action. */
    readonly message: string
  }

/** Which enrollment a browser is discarding. */
export interface ConnectorRevokeRequest {
  readonly enrollmentId: ConnectorEnrollmentId
}

/** Whether the revoked enrollment was still known. */
export interface ConnectorRevokeResult {
  /** False when the enrollment had already expired or been revoked. */
  readonly revoked: boolean
}
