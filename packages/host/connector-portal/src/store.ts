/**
 * The durable enrollment ledger: the reconnect credentials the portal must
 * keep across a harness restart, a plugin reload, and a machine's long
 * offline stretch.
 *
 * An enrollment's secret is this machine's standing credential for the
 * deployment — the agent presents it on every re-dial, forever, until the
 * user removes it. Holding those secrets only in memory made a restart wipe
 * every one, so a target left running dialled back into a deployment that no
 * longer knew it and was refused until someone issued a fresh pack. Persisting
 * the credential set closes that gap: the agent's own retry loop re-attaches
 * with the same secret after the deployment comes back up.
 *
 * Only the durable half of a record lives here. The live attachment is a
 * socket and its connector registration, which no restart can carry; the
 * download-window deadline is recomputed from `issuedAt` and the current
 * config; `downloadedAt` is a within-process refinement of the pack's status.
 * What the file holds is exactly the credential a re-dial needs: the id it
 * names, the secret it presents, and the target family the pack was cut for.
 *
 * The file is user-private (`0600` under a `0700` directory), written through
 * an atomic rename behind a cross-process writer lock so a concurrent writer
 * never reads a half-committed set, and rejected loud on a version it does not
 * know or bytes it cannot parse — an unreadable credential store is an
 * operator fault to see, never a silent empty ledger that revokes every
 * machine at once.
 *
 * @module @deepseek-ai/dsh-host-connector-portal/store
 */

import { readFileSync } from 'node:fs'
import { mkdir } from 'node:fs/promises'
import { dirname } from 'node:path'
import { withFileLock, writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'
import type { ConnectorPackOs } from './types.ts'

/**
 * On-disk format version. It advances only when the persisted fields change
 * structurally; a file naming a version this build does not know is refused
 * rather than reinterpreted, because guessing at an unknown layout would admit
 * or drop credentials the operator never chose.
 */
export const STORE_VERSION = 1

/** The target families a persisted enrollment may name. */
const PACK_FAMILIES: ReadonlySet<string> = new Set<ConnectorPackOs>(['linux', 'macos', 'windows'])

/**
 * The durable half of one enrollment: the credential a re-dial presents and
 * the pack family it was cut for. Everything else about a record is either a
 * live socket or a value recomputed on load.
 */
export interface PersistedEnrollment {
  /** Unguessable enrollment id; also the pack download's path segment. */
  readonly id: string
  /** The 24-byte secret half of the reconnect token, held at rest here. */
  readonly secret: string
  /** Target family the pack was generated for. */
  readonly os: ConnectorPackOs
  /** Epoch milliseconds the enrollment was issued at. */
  readonly issuedAt: number
}

/** The document one deployment's credential store holds. */
interface StoredLedger {
  readonly version: number
  readonly enrollments: readonly PersistedEnrollment[]
}

/** Whether a filesystem error means the store file is simply absent. */
function isENOENT(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | null)?.code === 'ENOENT'
}

/**
 * Reject a value that is not a well-formed persisted enrollment. A field the
 * build cannot trust is an operator fault to surface, not a record to drop.
 * @param value - one parsed array member.
 * @param filename - the store path, named in every failure.
 * @param index - the member's position, named so the operator can find it.
 * @returns the value narrowed to a persisted enrollment.
 */
function assertPersistedEnrollment(value: unknown, filename: string, index: number): PersistedEnrollment {
  const at = `${JSON.stringify(filename)} enrollment ${String(index)}`
  if (typeof value !== 'object' || value === null) {
    throw new Error(`connector-portal: ${at} is not an object`)
  }
  const record = value as Record<string, unknown>
  if (typeof record.id !== 'string' || record.id.length === 0) {
    throw new Error(`connector-portal: ${at} has no id`)
  }
  if (typeof record.secret !== 'string' || record.secret.length === 0) {
    throw new Error(`connector-portal: ${at} has no secret`)
  }
  if (typeof record.os !== 'string' || !PACK_FAMILIES.has(record.os)) {
    throw new Error(`connector-portal: ${at} names an unknown target family ${JSON.stringify(record.os)}`)
  }
  if (typeof record.issuedAt !== 'number' || !Number.isFinite(record.issuedAt)) {
    throw new Error(`connector-portal: ${at} has no issuedAt`)
  }
  return { id: record.id, secret: record.secret, os: record.os as ConnectorPackOs, issuedAt: record.issuedAt }
}

/**
 * Parse and validate one store document, failing loud on anything it cannot
 * trust.
 * @param text - the file's contents.
 * @param filename - the store path, named in every failure.
 * @returns the persisted enrollments the file holds.
 */
function parseLedger(text: string, filename: string): PersistedEnrollment[] {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch (error) {
    throw new Error(`connector-portal: enrollment store ${JSON.stringify(filename)} is not valid JSON (${String(error)})`)
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error(`connector-portal: enrollment store ${JSON.stringify(filename)} is not a ledger document`)
  }
  const document = parsed as Partial<StoredLedger>
  if (document.version !== STORE_VERSION) {
    throw new Error(`connector-portal: enrollment store ${JSON.stringify(filename)} is version ${String(document.version)}, this build reads version ${String(STORE_VERSION)}`)
  }
  if (!Array.isArray(document.enrollments)) {
    throw new Error(`connector-portal: enrollment store ${JSON.stringify(filename)} carries no enrollments array`)
  }
  return document.enrollments.map((value, index) => assertPersistedEnrollment(value, filename, index))
}

/** The file-backed reconnect-credential store of one deployment. */
export class ConnectorEnrollmentStore {
  /** @param filename - absolute path of the credential store document. */
  constructor(private readonly filename: string) {}

  /**
   * Read the persisted credential set at boot. An absent file is an empty
   * ledger; an unreadable, unparsable, or unknown-version file throws, because
   * silently starting empty would refuse every machine the operator enrolled.
   *
   * The read is synchronous and lock-free: it runs once before the plugin
   * answers any request, and the atomic rename every write commits through
   * means a concurrent writer is observed as either the whole old set or the
   * whole new one, never a torn document.
   * @returns the persisted enrollments, oldest first, or an empty list.
   */
  loadSync(): PersistedEnrollment[] {
    let text: string
    try {
      text = readFileSync(this.filename, 'utf8')
    } catch (error) {
      if (isENOENT(error)) return []
      throw error
    }
    return parseLedger(text, this.filename)
  }

  /**
   * Replace the credential set on disk. The document is written to a
   * random-suffix sibling and renamed over the target behind a cross-process
   * writer lock, so a reader always sees a complete set and two writers cannot
   * interleave a read-modify-write.
   * @param enrollments - the durable half of every enrollment currently held.
   * @returns once the new set is the file's committed content.
   */
  async save(enrollments: readonly PersistedEnrollment[]): Promise<void> {
    const document: StoredLedger = { version: STORE_VERSION, enrollments }
    const body = `${JSON.stringify(document, null, 2)}\n`
    // The writer lock is a sibling of the store file, so the user-private
    // parent directory must exist before the lock is taken — the first save
    // on a fresh harness home is what creates it.
    await mkdir(dirname(this.filename), { recursive: true, mode: 0o700 })
    await withFileLock(this.filename, async () => {
      await writeFileAtomic(this.filename, body, { mode: 0o600, dirMode: 0o700 })
    })
  }
}
