/**
 * The enrollment ledger: one record per target machine a user has generated a
 * pack for, from the moment the pack is issued until the enrollment is revoked
 * or the harness process ends.
 *
 * An enrollment separates two lifetimes deliberately. The pack DOWNLOAD is
 * short-lived, because the file carries the secret and a stale link in a chat
 * log or shell history is the realistic leak. The ATTACHMENT it authorizes is
 * not: a target left running should survive a laptop sleeping, a network
 * moving, and the deployment restarting its own upstream, without asking the
 * user to re-download anything.
 *
 * Records live in memory. A harness restart drops every enrollment, and each
 * agent's retry loop then reports a refused attachment until the user issues a
 * new pack — visible, rather than a target silently serving a deployment that
 * no longer knows why.
 *
 * @module @deepseek-ai/dsh-host-connector-portal/enrollment
 */

import { Buffer } from 'node:buffer'
import { randomBytes, timingSafeEqual } from 'node:crypto'
import type { ConnectorEnrollmentId, ConnectorEnrollmentView, ConnectorPackOs } from './types.ts'

/** Bytes of entropy behind an enrollment id and behind its secret. */
const SECRET_BYTES = 24

/** What an attached agent told the deployment about its machine. */
export interface ConnectorAttachment {
  /** Operator-facing name the agent reported. */
  readonly label: string
  /** Default working directory the agent serves. */
  readonly workdir: string
  /** Epoch milliseconds the attachment completed at. */
  readonly attachedAt: number
  /** Drops the connection and removes the connector registration. */
  readonly release: () => Promise<void>
}

/** One target machine's record. */
export interface ConnectorEnrollment {
  readonly id: ConnectorEnrollmentId
  /** Secret half of the pack token; never leaves this process except inside a pack. */
  readonly secret: string
  readonly os: ConnectorPackOs
  readonly issuedAt: number
  /** Epoch milliseconds after which the pack download stops answering. */
  readonly expiresAt: number
  /** Epoch milliseconds of the first pack download, or undefined. */
  downloadedAt?: number
  /** The live attachment, while one agent is connected. */
  attachment?: ConnectorAttachment
}

/** Reasons an attach attempt is refused, as the agent's operator sees them. */
export type ConnectorAttachRefusal = 'unknown-token' | 'capacity'

/** Whether an attach attempt was admitted, and which enrollment it named. */
export type ConnectorAttachDecision =
  | { readonly admitted: true; readonly enrollment: ConnectorEnrollment }
  | { readonly admitted: false; readonly refusal: ConnectorAttachRefusal }

/** Random URL- and shell-safe text with no separator character in it. */
function mintSecret(): string {
  return randomBytes(SECRET_BYTES).toString('base64url')
}

/** Compare secrets without leaking their common prefix length through timing. */
function secretsMatch(offered: string, expected: string): boolean {
  const left = Buffer.from(offered, 'utf8')
  const right = Buffer.from(expected, 'utf8')
  return left.length === right.length && timingSafeEqual(left, right)
}

/**
 * The token an agent presents. Naming the enrollment in the token itself keeps
 * the lookup a single map read on one fixed upgrade path, which is all the
 * webserver's exact-path upgrade registry offers.
 * @param enrollment - the record the token belongs to.
 * @returns the token text embedded in that enrollment's pack.
 */
export function enrollmentToken(enrollment: ConnectorEnrollment): string {
  return `${String(enrollment.id)}.${enrollment.secret}`
}

/** The enrollment ledger of one deployment. */
export class ConnectorEnrollments {
  private readonly records = new Map<string, ConnectorEnrollment>()

  /**
   * @param packTtlMs - how long a freshly issued pack stays downloadable.
   * @param maxAttached - how many targets may be attached at once.
   */
  constructor(private readonly packTtlMs: number, private readonly maxAttached: number) {}

  /**
   * Record one new target machine and mint its credentials.
   * @param os - target family the pack will be generated for.
   * @param now - current epoch milliseconds.
   * @returns the new enrollment.
   */
  issue(os: ConnectorPackOs, now: number): ConnectorEnrollment {
    const enrollment: ConnectorEnrollment = {
      id: mintSecret() as ConnectorEnrollmentId,
      secret: mintSecret(),
      os,
      issuedAt: now,
      expiresAt: now + this.packTtlMs,
    }
    this.records.set(String(enrollment.id), enrollment)
    return enrollment
  }

  /**
   * Resolve the enrollment a pack download names, and mark it downloaded.
   * @param id - the path segment the download carried.
   * @param now - current epoch milliseconds.
   * @returns the enrollment, or undefined when it is unknown or its download window has closed.
   */
  claimDownload(id: string, now: number): ConnectorEnrollment | undefined {
    const enrollment = this.records.get(id)
    if (enrollment === undefined || now >= enrollment.expiresAt) return undefined
    enrollment.downloadedAt ??= now
    return enrollment
  }

  /**
   * Decide one attach attempt. An expired download window does not close an
   * attachment: the pack is what expires, not the machine it enrolled.
   * @param token - the token the agent presented.
   * @returns the admitted enrollment, or why the attempt was refused.
   */
  admitAttach(token: string): ConnectorAttachDecision {
    const separator = token.indexOf('.')
    const enrollment = separator === -1 ? undefined : this.records.get(token.slice(0, separator))
    if (enrollment === undefined || !secretsMatch(token.slice(separator + 1), enrollment.secret)) {
      return { admitted: false, refusal: 'unknown-token' }
    }
    // A re-dial of an enrollment that is already attached replaces its own
    // connection rather than counting against capacity: the previous socket is
    // a stale one the target itself has given up on.
    const others = [...this.records.values()]
      .filter(record => record !== enrollment && record.attachment !== undefined).length
    if (others >= this.maxAttached) return { admitted: false, refusal: 'capacity' }
    return { admitted: true, enrollment }
  }

  /**
   * Look one enrollment up without changing it.
   * @param id - the enrollment id.
   * @returns the record, or undefined when it is unknown.
   */
  get(id: string): ConnectorEnrollment | undefined {
    return this.records.get(id)
  }

  /**
   * Forget one enrollment. Its live attachment, when there is one, is the
   * caller's to release first.
   * @param id - the enrollment id.
   * @returns the removed record, or undefined when it was already gone.
   */
  remove(id: string): ConnectorEnrollment | undefined {
    const enrollment = this.records.get(id)
    if (enrollment !== undefined) this.records.delete(id)
    return enrollment
  }

  /**
   * Every enrollment, oldest first.
   * @returns the records in issue order.
   */
  all(): ConnectorEnrollment[] {
    return [...this.records.values()]
  }

  /**
   * Project the ledger onto what the browser renders.
   * @param now - current epoch milliseconds, deciding which packs read as expired.
   * @returns one view per enrollment, oldest first.
   */
  view(now: number): ConnectorEnrollmentView[] {
    return this.all().map(enrollment => ({
      enrollmentId: enrollment.id,
      connectorId: String(enrollment.id),
      os: enrollment.os,
      status: statusOf(enrollment, now),
      label: enrollment.attachment?.label ?? null,
      workdir: enrollment.attachment?.workdir ?? null,
      issuedAt: enrollment.issuedAt,
      expiresAt: enrollment.expiresAt,
    }))
  }
}

/** Which of the four lifecycle words describes one record right now. */
function statusOf(enrollment: ConnectorEnrollment, now: number): ConnectorEnrollmentView['status'] {
  if (enrollment.attachment !== undefined) return 'attached'
  if (now >= enrollment.expiresAt) return 'expired'
  return enrollment.downloadedAt === undefined ? 'issued' : 'downloaded'
}
