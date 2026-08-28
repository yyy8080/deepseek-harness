/**
 * Tests for deriving the pack's dial-back origin from a download request. The
 * value reaches a script the target executes, so every case that is not a
 * canonical authority must yield nothing rather than a guess.
 */

import type { IncomingHttpHeaders } from 'node:http'
import { describe, expect, it } from 'vitest'
import { requestOrigin } from '../src/origin.ts'

describe('requestOrigin', () => {
  it('defaults to http when no proxy states a scheme', () => {
    expect(requestOrigin({ host: 'harness.example.com' })).toBe('http://harness.example.com')
  })

  it('keeps a non-default port', () => {
    expect(requestOrigin({ host: '127.0.0.1:3080' })).toBe('http://127.0.0.1:3080')
  })

  it.each([
    ['https', 'https://harness.example.com'],
    ['HTTPS', 'https://harness.example.com'],
    ['http', 'http://harness.example.com'],
  ])('honours a single forwarded %s scheme', (proto, origin) => {
    expect(requestOrigin({ 'host': 'harness.example.com', 'x-forwarded-proto': proto })).toBe(origin)
  })

  it('ignores a forwarded scheme list rather than picking a member', () => {
    expect(requestOrigin({ 'host': 'harness.example.com', 'x-forwarded-proto': 'https, http' }))
      .toBe('http://harness.example.com')
  })

  // A repeated Host reaches the handler as a list, which `IncomingHttpHeaders`
  // does not describe for this header; the cast states the wire fact the type
  // omits rather than weakening the function's parameter.
  it.each<[string, IncomingHttpHeaders]>([
    ['no Host at all', {}],
    ['a repeated Host', { host: ['a.example.com', 'b.example.com'] as unknown as string }],
    ['a Host carrying a path', { host: 'harness.example.com/evil' }],
    ['a Host carrying credentials', { host: 'user@harness.example.com' }],
    ['a Host carrying a query', { host: 'harness.example.com?x=1' }],
    ['an unparseable Host', { host: 'not a host' }],
  ])('yields nothing for %s', (_case, headers) => {
    expect(requestOrigin(headers)).toBeUndefined()
  })

  it('accepts a Host whose only difference is case, canonicalized', () => {
    expect(requestOrigin({ host: 'Harness.Example.COM' })).toBe('http://harness.example.com')
  })
})
