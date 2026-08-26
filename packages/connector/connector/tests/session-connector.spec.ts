/**
 * Tests for the per-session connector binding: the pure fold over the session
 * log and the single write path that appends to it.
 */

import { describe, expect, it } from 'vitest'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import { ConnectorId, bindSessionConnector, effectiveConnectorId } from '@deepseek-ai/dsh-connector'

function session(id: string): Session {
  const sessionId = SessionId(id)
  return Session.create(sessionId, undefined, { version: 0, id: sessionId, createdAt: 0 })
}

describe('session connector binding', () => {
  it('reports no binding for a session that never bound one', () => {
    expect(effectiveConnectorId(session('none').events)).toBeUndefined()
  })

  it('reports the last binding after a rebind', () => {
    const active = session('rebound')
    bindSessionConnector(active, ConnectorId('build-linux'))
    bindSessionConnector(active, ConnectorId('lab-windows'))

    expect(effectiveConnectorId(active.events)).toBe('lab-windows')
  })

  it('skips unrelated events between bindings', () => {
    const active = session('mixed')
    bindSessionConnector(active, ConnectorId('build-linux'))
    active.append('turn/start', { turn: 1 })

    expect(effectiveConnectorId(active.events)).toBe('build-linux')
  })
})
