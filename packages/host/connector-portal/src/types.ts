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

/** Point-in-time view of every enrollment this deployment is holding. */
export interface ConnectorPortalSnapshot {
  readonly enrollments: readonly ConnectorEnrollmentView[]
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
