/** Single-sample LAN-trust resolution for the /api browser-trust fence (`resolveLanTrust`). */

import { describe, expect, it, vi } from 'vitest'
import { resolveLanTrust } from '../src/index.ts'

vi.mock('node:os', () => ({
  networkInterfaces: () => ({
    lo0: [
      { family: 'IPv4', internal: true, address: '127.0.0.1' },
    ],
    en0: [
      { family: 'IPv6', internal: false, address: 'fe80::1' },
      { family: 'IPv4', internal: false, address: '192.168.1.5' },
    ],
    en1: [
      { family: 'IPv4', internal: false, address: '10.0.0.7' },
    ],
    utun0: undefined,
  }),
}))

describe('resolveLanTrust', () => {
  it('samples non-internal IPv4 addresses once for an all-interfaces bind: trust and display share them', () => {
    const { lanAddresses, trustedHosts } = resolveLanTrust('0.0.0.0', ['harness.internal:3080'], 'loopback')
    expect(lanAddresses).toEqual(['192.168.1.5', '10.0.0.7'])
    expect(trustedHosts).toEqual(['192.168.1.5', '10.0.0.7', 'harness.internal:3080'])
  })

  it('derives nothing for a loopback bind — extras alone stand, no LAN URL to print', () => {
    expect(resolveLanTrust('127.0.0.1', [], 'loopback'))
      .toEqual({ lanAddresses: [], trustedHosts: [], configurationPlane: 'loopback' })
    expect(resolveLanTrust('127.0.0.1', ['lab.internal'], 'loopback'))
      .toEqual({ lanAddresses: [], trustedHosts: ['lab.internal'], configurationPlane: 'loopback' })
  })

  it('forwards the invocation scope so the fence row and the browser read one answer', () => {
    expect(resolveLanTrust('0.0.0.0', ['harness.internal'], 'trusted-hosts').configurationPlane)
      .toBe('trusted-hosts')
  })
})
