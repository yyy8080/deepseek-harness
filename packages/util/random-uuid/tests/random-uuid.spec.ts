import { afterEach, describe, expect, it, vi } from 'vitest'
import { randomUuid } from '@deepseek-ai/dsh-random-uuid'

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('randomUuid', () => {
  it('delegates to crypto.randomUUID where the platform exposes it', () => {
    const randomUUID = vi.fn(() => '11111111-2222-4333-8444-555555555555' as const)
    vi.stubGlobal('crypto', { randomUUID, getRandomValues: () => { throw new Error('unused') } })
    expect(randomUuid()).toBe('11111111-2222-4333-8444-555555555555')
    expect(randomUUID).toHaveBeenCalledOnce()
  })

  it('falls back to getRandomValues on an insecure origin, where randomUUID is absent', () => {
    let next = 0
    const getRandomValues = vi.fn((bytes: Uint8Array) => {
      for (let index = 0; index < bytes.length; index += 1) bytes[index] = next++
      return bytes
    })
    vi.stubGlobal('crypto', { getRandomValues })
    expect(randomUuid()).toBe('00010203-0405-4607-8809-0a0b0c0d0e0f')
    expect(getRandomValues).toHaveBeenCalledOnce()
  })

  it('stamps version 4 and variant 1 over every fallback byte pattern', () => {
    for (const fill of [0x00, 0x55, 0xaa, 0xff]) {
      vi.stubGlobal('crypto', { getRandomValues: (bytes: Uint8Array) => bytes.fill(fill) })
      expect(randomUuid()).toMatch(UUID_V4)
    }
  })

  it('mints distinct values from the platform CSPRNG', () => {
    const minted = new Set(Array.from({ length: 64 }, () => randomUuid()))
    expect(minted.size).toBe(64)
    for (const value of minted) expect(value).toMatch(UUID_V4)
  })
})
