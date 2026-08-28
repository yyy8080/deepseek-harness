/**
 * The enrollment ledger: one record per target machine a user has generated a
 * pack for, from the moment the pack is issued until the user revokes it.
 *
 * An enrollment separates two lifetimes deliberately. The pack DOWNLOAD may be
 * short-lived, because the file carries the secret and a stale link in a chat
 * log or shell history is the realistic leak; a deployment can also leave it
 * open. The reconnect credential the enrollment mints is never short-lived: a
 * target left running should survive a laptop sleeping, a network moving, the
 * deployment restarting, and this plugin reloading, without asking the user to
 * re-download anything. The secret is the machine's standing credential until
 * the user removes it.
 *
 * The credential set is durable: {@link ConnectorEnrollments} is constructed
 * from whatever the store restored and reports its current set back for the
 * portal to persist. The live attachment — a socket and its connector
 * registration — is the one part no restart can carry; the agent's own retry
 * loop re-dials and re-attaches with the same secret once the deployment is
 * back up.
 *
 * @module @deepseek-ai/dsh-host-connector-portal/enrollment
 */

import { Buffer } from 'node:buffer'
import { randomBytes, timingSafeEqual } from 'node:crypto'
import type { ConnectorEnrollmentId, ConnectorEnrollmentView, ConnectorPackOs } from './types.ts'
import type { PersistedEnrollment } from './store.ts'

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
  /**
   * Epoch milliseconds after which the pack download stops answering, or
   * `null` when the download never expires. It gates only the download of the
   * script file; the reconnect credential the pack carries never expires.
   */
  readonly expiresAt: number | null
  /** Epoch milliseconds of the first pack download, or undefined. */
  downloadedAt?: number
  /** The live attachment, while one agent is connected. */
  attachment?: ConnectorAttachment
  /**
   * Which admitted attach this record's attachment slot currently belongs to.
   * It advances whenever an in-flight adoption becomes stale — a later attach
   * was admitted, or the record was discarded — so an adoption that completes
   * its handshake late can tell that the slot is no longer its own.
   */
  attachGeneration: number
}

/** Reasons an attach attempt is refused, as the agent's operator sees them. */
export type ConnectorAttachRefusal = 'unknown-token' | 'capacity'

/** Whether an attach attempt was admitted, and which enrollment it named. */
export type ConnectorAttachDecision =
  | {
    readonly admitted: true
    readonly enrollment: ConnectorEnrollment
    /** Generation this attempt owns; it may adopt only while the record still reads the same. */
    readonly generation: number
  }
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

/** Recompute one restored record's download deadline from the current TTL. */
function expiryOf(packTtlMs: number, issuedAt: number): number | null {
  return packTtlMs === 0 ? null : issuedAt + packTtlMs
}

/** The enrollment ledger of one deployment. */
export class ConnectorEnrollments {
  private readonly records = new Map<string, ConnectorEnrollment>()

  /**
   * @param packTtlMs - how long a freshly issued pack stays downloadable; `0`
   *   leaves the download open until the enrollment is revoked.
   * @param maxAttached - how many targets may be attached at once.
   * @param restored - the durable half of every enrollment the store held,
   *   restored so a re-dial after a restart is admitted with the same secret.
   */
  constructor(
    private readonly packTtlMs: number,
    private readonly maxAttached: number,
    restored: readonly PersistedEnrollment[] = [],
  ) {
    for (const record of restored) {
      this.records.set(record.id, {
        id: record.id as ConnectorEnrollmentId,
        secret: record.secret,
        os: record.os,
        issuedAt: record.issuedAt,
        expiresAt: expiryOf(this.packTtlMs, record.issuedAt),
        attachGeneration: 0,
      })
    }
  }

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
      expiresAt: expiryOf(this.packTtlMs, now),
      attachGeneration: 0,
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
    if (enrollment === undefined) return undefined
    if (enrollment.expiresAt !== null && now >= enrollment.expiresAt) return undefined
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
    enrollment.attachGeneration += 1
    return { admitted: true, enrollment, generation: enrollment.attachGeneration }
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
   * caller's to release first, and an adoption still shaking hands for it is
   * retired by the generation bump.
   * @param id - the enrollment id.
   * @returns the removed record, or undefined when it was already gone.
   */
  remove(id: string): ConnectorEnrollment | undefined {
    const enrollment = this.records.get(id)
    if (enrollment === undefined) return undefined
    this.records.delete(id)
    enrollment.attachGeneration += 1
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
   * The durable half of every enrollment, for the portal to persist. It omits
   * the live attachment and the recomputed download deadline, keeping exactly
   * the credential a re-dial after a restart needs.
   * @returns one persisted record per enrollment, oldest first.
   */
  snapshot(): PersistedEnrollment[] {
    return this.all().map(enrollment => ({
      id: String(enrollment.id),
      secret: enrollment.secret,
      os: enrollment.os,
      issuedAt: enrollment.issuedAt,
    }))
  }

  /**
   * Project the ledger onto what the browser renders.
   * @returns one view per enrollment, oldest first.
   */
  view(): ConnectorEnrollmentView[] {
    return this.all().map(enrollment => ({
      enrollmentId: enrollment.id,
      connectorId: String(enrollment.id),
      os: enrollment.os,
      status: statusOf(enrollment),
      label: enrollment.attachment?.label ?? null,
      workdir: enrollment.attachment?.workdir ?? null,
      issuedAt: enrollment.issuedAt,
    }))
  }
}

/**
 * Which lifecycle word describes one record right now. The credential never
 * expires, so a record is only ever waiting for its pack to be downloaded,
 * waiting for its agent to dial in, or attached.
 */
function statusOf(enrollment: ConnectorEnrollment): ConnectorEnrollmentView['status'] {
  if (enrollment.attachment !== undefined) return 'attached'
  return enrollment.downloadedAt === undefined ? 'issued' : 'downloaded'
}
