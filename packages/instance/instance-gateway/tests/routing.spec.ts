import { describe, expect, it } from 'vitest'
import type { InstanceId } from '@deepseek-ai/dsh-instance'
import {
  globalize,
  globalSessionId,
  INSTANCE_ID_SEPARATOR,
  localize,
  splitGlobalSessionId,
} from '@deepseek-ai/dsh-instance-gateway'

const alpha = 'inst-1' as InstanceId
const beta = 'inst-2' as InstanceId

describe('global session ids', () => {
  it('round-trips through compose and split', () => {
    const global = globalSessionId(alpha, 'session-abc')
    expect(global).toBe(`inst-1${INSTANCE_ID_SEPARATOR}session-abc`)
    expect(splitGlobalSessionId(global)).toEqual({ instanceId: alpha, localSessionId: 'session-abc' })
  })

  it('reads no instance out of an id that carries no usable prefix', () => {
    expect(splitGlobalSessionId('session-abc')).toBeUndefined()
    expect(splitGlobalSessionId(`${INSTANCE_ID_SEPARATOR}session-abc`)).toBeUndefined()
    expect(splitGlobalSessionId(`inst-1${INSTANCE_ID_SEPARATOR}`)).toBeUndefined()
  })

  it('splits at the first separator, so a local id may carry one', () => {
    const global = globalSessionId(alpha, `a${INSTANCE_ID_SEPARATOR}b`)
    expect(splitGlobalSessionId(global))
      .toEqual({ instanceId: alpha, localSessionId: `a${INSTANCE_ID_SEPARATOR}b` })
  })
})

describe('globalize', () => {
  it('rewrites every declared session-id property, at any depth', () => {
    const value = globalize({
      sessionId: 'session-1',
      items: [{ sessionId: 'session-2', parentSessionId: 'session-3' }],
      nested: { deep: { childSessionId: 'session-4', beforeSessionId: 'session-5' } },
    }, alpha)

    expect(value).toEqual({
      sessionId: 'inst-1~session-1',
      items: [{ sessionId: 'inst-1~session-2', parentSessionId: 'inst-1~session-3' }],
      nested: { deep: { childSessionId: 'inst-1~session-4', beforeSessionId: 'inst-1~session-5' } },
    })
  })

  it('rewrites the declared session-id arrays element-wise', () => {
    expect(globalize({ sessionIds: ['a', 'b'], archivedSessionIds: ['c'] }, alpha))
      .toEqual({ sessionIds: ['inst-1~a', 'inst-1~b'], archivedSessionIds: ['inst-1~c'] })
  })

  it('leaves ids the gateway does not own untouched', () => {
    const value = { callId: 'call-1', approvalId: 'appr-1', itemId: 'msg-1', title: 'session-lookalike' }
    expect(globalize(value, alpha)).toEqual(value)
  })

  it('passes non-object leaves through unchanged', () => {
    expect(globalize({ count: 3, ok: true, missing: null }, alpha))
      .toEqual({ count: 3, ok: true, missing: null })
  })
})

describe('localize', () => {
  it('strips the prefix of the instance a call is routed to', () => {
    expect(localize({ sessionId: 'inst-1~session-1', beforeSeq: 4 }, alpha))
      .toEqual({ sessionId: 'session-1', beforeSeq: 4 })
  })

  it('refuses an id addressed to a different instance', () => {
    expect(() => localize({ sessionId: 'inst-2~session-1' }, alpha))
      .toThrow(/belongs to instance inst-2, not inst-1/)
  })

  it('refuses an id carrying no instance prefix', () => {
    expect(() => localize({ sessionId: 'session-1' }, beta))
      .toThrow(/carries no instance prefix/)
  })

  it('inverts globalize', () => {
    const original = { sessionId: 's1', items: [{ parentSessionId: 's2' }], sessionIds: ['s3'] }
    expect(localize(globalize(original, alpha), alpha)).toEqual(original)
  })
})
