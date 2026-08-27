/**
 * Tests for the enrollment ledger: the two independent lifetimes it tracks (a
 * short download window and an open-ended attachment), the token an agent must
 * present, and the capacity the deployment enforces.
 */

import { describe, expect, it } from 'vitest'
import { ConnectorEnrollments, enrollmentToken } from '../src/enrollment.ts'
import type { ConnectorEnrollment } from '../src/enrollment.ts'

const TTL_MS = 1000

function ledger(maxAttached = 2): ConnectorEnrollments {
  return new ConnectorEnrollments(TTL_MS, maxAttached)
}

/** Mark one record attached with a release that records having run. */
function attach(enrollment: ConnectorEnrollment, label = 'box'): { released: boolean } {
  const state = { released: false }
  enrollment.attachment = {
    label,
    workdir: '/srv/work',
    attachedAt: 0,
    release: () => { state.released = true; return Promise.resolve() },
  }
  return state
}

describe('issuing', () => {
  it('mints an unguessable id and a separate secret', () => {
    const first = ledger().issue('linux', 0)
    const second = ledger().issue('linux', 0)

    expect(String(first.id)).toHaveLength(32)
    expect(first.secret).toHaveLength(32)
    expect(String(first.id)).not.toBe(first.secret)
    expect(String(first.id)).not.toBe(String(second.id))
  })

  it('closes the download window a TTL after issue', () => {
    expect(ledger().issue('windows', 5000).expiresAt).toBe(5000 + TTL_MS)
  })
})

describe('claiming a download', () => {
  it('answers inside the window and records the first download', () => {
    const enrollments = ledger()
    const enrollment = enrollments.issue('linux', 0)

    expect(enrollments.claimDownload(String(enrollment.id), 500)).toBe(enrollment)
    expect(enrollment.downloadedAt).toBe(500)
    expect(enrollments.claimDownload(String(enrollment.id), 900)?.downloadedAt).toBe(500)
  })

  it('stops answering once the window closes', () => {
    const enrollments = ledger()
    const enrollment = enrollments.issue('linux', 0)

    expect(enrollments.claimDownload(String(enrollment.id), TTL_MS)).toBeUndefined()
  })

  it('does not answer for an unknown id', () => {
    expect(ledger().claimDownload('nope', 0)).toBeUndefined()
  })
})

describe('admitting an attach', () => {
  it('admits the enrollment its token names', () => {
    const enrollments = ledger()
    const enrollment = enrollments.issue('linux', 0)

    expect(enrollments.admitAttach(enrollmentToken(enrollment)))
      .toEqual({ admitted: true, enrollment, generation: 1 })
  })

  it('retires an earlier admission when the same machine dials again', () => {
    const enrollments = ledger()
    const enrollment = enrollments.issue('linux', 0)
    const first = enrollments.admitAttach(enrollmentToken(enrollment))

    const second = enrollments.admitAttach(enrollmentToken(enrollment))

    expect(first).toMatchObject({ admitted: true, generation: 1 })
    expect(second).toMatchObject({ admitted: true, generation: 2 })
    expect(enrollment.attachGeneration).toBe(2)
  })

  it('retires an in-flight admission when the record is discarded', () => {
    const enrollments = ledger()
    const enrollment = enrollments.issue('linux', 0)
    const admitted = enrollments.admitAttach(enrollmentToken(enrollment))

    enrollments.remove(String(enrollment.id))

    expect(admitted).toMatchObject({ admitted: true, generation: 1 })
    expect(enrollment.attachGeneration).toBe(2)
  })

  it('admits after the download window closed, because the pack expires and the machine does not', () => {
    const enrollments = ledger()
    const enrollment = enrollments.issue('linux', 0)
    enrollments.claimDownload(String(enrollment.id), 0)

    expect(enrollments.admitAttach(enrollmentToken(enrollment)).admitted).toBe(true)
  })

  it.each([
    ['a token with no separator', (e: ConnectorEnrollment) => String(e.id)],
    ['an unknown enrollment', () => 'nope.secret'],
    ['the wrong secret', (e: ConnectorEnrollment) => `${String(e.id)}.wrong`],
    ['a truncated secret', (e: ConnectorEnrollment) => `${String(e.id)}.${e.secret.slice(0, -1)}`],
  ])('refuses %s', (_case, token) => {
    const enrollments = ledger()
    const enrollment = enrollments.issue('linux', 0)

    expect(enrollments.admitAttach(token(enrollment)))
      .toEqual({ admitted: false, refusal: 'unknown-token' })
  })

  it('refuses once the configured number of machines is already attached', () => {
    const enrollments = ledger(1)
    attach(enrollments.issue('linux', 0))
    const second = enrollments.issue('linux', 0)

    expect(enrollments.admitAttach(enrollmentToken(second)))
      .toEqual({ admitted: false, refusal: 'capacity' })
  })

  it('lets an already-attached machine replace its own stale connection at capacity', () => {
    const enrollments = ledger(1)
    const enrollment = enrollments.issue('linux', 0)
    attach(enrollment)

    expect(enrollments.admitAttach(enrollmentToken(enrollment)).admitted).toBe(true)
  })
})

describe('the ledger the browser reads', () => {
  it('reports each record\'s lifecycle word', () => {
    const enrollments = ledger()
    const issued = enrollments.issue('linux', 0)
    const downloaded = enrollments.issue('windows', 0)
    enrollments.claimDownload(String(downloaded.id), 0)
    const attached = enrollments.issue('macos', 0)
    attach(attached, 'build-box')

    expect(enrollments.view(0).map(row => row.status)).toEqual(['issued', 'downloaded', 'attached'])
    expect(enrollments.view(TTL_MS).map(row => row.status)).toEqual(['expired', 'expired', 'attached'])
    expect(enrollments.view(0)[2]).toMatchObject({
      connectorId: String(attached.id),
      label: 'build-box',
      workdir: '/srv/work',
      os: 'macos',
    })
    expect(enrollments.view(0)[0]).toMatchObject({ connectorId: String(issued.id), label: null, workdir: null })
  })

  it('forgets one record and reports whether it was still known', () => {
    const enrollments = ledger()
    const enrollment = enrollments.issue('linux', 0)

    expect(enrollments.get(String(enrollment.id))).toBe(enrollment)
    expect(enrollments.remove(String(enrollment.id))).toBe(enrollment)
    expect(enrollments.remove(String(enrollment.id))).toBeUndefined()
    expect(enrollments.get(String(enrollment.id))).toBeUndefined()
    expect(enrollments.all()).toEqual([])
  })
})
