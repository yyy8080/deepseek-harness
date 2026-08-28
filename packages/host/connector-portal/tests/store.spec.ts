/**
 * Tests for the durable credential store: the round trip a persisted set makes
 * to disk and back, and the loud refusal of anything it cannot trust to be the
 * exact set the operator chose.
 */

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { ConnectorEnrollmentStore, STORE_VERSION } from '../src/store.ts'
import type { PersistedEnrollment } from '../src/store.ts'

const dirs: string[] = []

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

/** A fresh store-file path under its own temp directory. */
function storePath(): string {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-connector-store-'))
  dirs.push(dir)
  return join(dir, 'enrollments.json')
}

/** One well-formed persisted record. */
function record(overrides: Partial<PersistedEnrollment> = {}): PersistedEnrollment {
  return { id: 'box-1', secret: 'kept-secret', os: 'linux', issuedAt: 100, ...overrides }
}

describe('loading', () => {
  it('reads an absent store as an empty ledger', () => {
    expect(new ConnectorEnrollmentStore(storePath()).loadSync()).toEqual([])
  })

  it('round-trips a saved credential set', async () => {
    const path = storePath()
    const store = new ConnectorEnrollmentStore(path)
    const set = [record(), record({ id: 'box-2', os: 'windows', issuedAt: 200 })]

    await store.save(set)

    expect(new ConnectorEnrollmentStore(path).loadSync()).toEqual(set)
    expect(JSON.parse(readFileSync(path, 'utf8'))).toMatchObject({ version: STORE_VERSION })
  })

  it('replaces the whole set on each save', async () => {
    const path = storePath()
    const store = new ConnectorEnrollmentStore(path)
    await store.save([record()])
    await store.save([record({ id: 'box-2', issuedAt: 200 })])

    expect(new ConnectorEnrollmentStore(path).loadSync()).toEqual([record({ id: 'box-2', issuedAt: 200 })])
  })
})

describe('refusing what it cannot trust', () => {
  it.each([
    ['bytes that are not JSON', 'not json', 'is not valid JSON'],
    ['a JSON array', '[]', 'is not a ledger document'],
    ['a version this build does not read', JSON.stringify({ version: 999, enrollments: [] }), 'this build reads version'],
    ['no enrollments array', JSON.stringify({ version: STORE_VERSION }), 'carries no enrollments array'],
    ['a member that is not an object', JSON.stringify({ version: STORE_VERSION, enrollments: [1] }), 'is not an object'],
    ['a member with no id', JSON.stringify({ version: STORE_VERSION, enrollments: [{ secret: 's', os: 'linux', issuedAt: 1 }] }), 'has no id'],
    ['a member with no secret', JSON.stringify({ version: STORE_VERSION, enrollments: [{ id: 'a', os: 'linux', issuedAt: 1 }] }), 'has no secret'],
    ['a member with an unknown family', JSON.stringify({ version: STORE_VERSION, enrollments: [{ id: 'a', secret: 's', os: 'plan9', issuedAt: 1 }] }), 'unknown target family'],
    ['a member with no issuedAt', JSON.stringify({ version: STORE_VERSION, enrollments: [{ id: 'a', secret: 's', os: 'linux' }] }), 'has no issuedAt'],
  ])('fails loud on %s', (_case, body, detail) => {
    const path = storePath()
    writeFileSync(path, body)

    expect(() => new ConnectorEnrollmentStore(path).loadSync()).toThrow(detail)
  })

  it('surfaces a read failure other than absence', () => {
    // A directory at the store path reads as EISDIR rather than ENOENT, so the
    // store must let it through instead of mistaking it for an empty ledger.
    const dir = mkdtempSync(join(tmpdir(), 'dsh-connector-store-'))
    dirs.push(dir)

    expect(() => new ConnectorEnrollmentStore(dir).loadSync()).toThrow()
  })
})
