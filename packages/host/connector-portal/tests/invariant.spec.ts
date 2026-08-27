/**
 * Tests for the portal's invariant companion: the relation between what it
 * announces as attached and what a session could actually bind to.
 */

import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import ConnectorRegistry, { ConnectorId } from '@deepseek-ai/dsh-connector'
import InvariantRegistry from '@deepseek-ai/dsh-invariants'
import * as ConnectorPortalInvariant from '../src/invariant.ts'
import type { ConnectorEnrollmentId } from '../src/types.ts'

async function host(): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(ConnectorRegistry, {})
  await ctx.plugin(InvariantRegistry, { enabled: true })
  await ctx.plugin(ConnectorPortalInvariant)
  return ctx
}

describe('the announced-attachment relation', () => {
  it('accepts an announcement the registry can answer for', async () => {
    const ctx = await host()
    ctx.connectors.register(
      { id: ConnectorId('build-box'), os: 'linux', workdir: '/srv/work' },
      () => Promise.reject(new Error('this test never opens the link')),
    )

    expect(() => { ctx.emit('connector-portal/attached', 'build-box' as ConnectorEnrollmentId) }).not.toThrow()
  })

  it('rejects an announcement no session could bind', async () => {
    const ctx = await host()

    expect(() => { ctx.emit('connector-portal/attached', 'ghost' as ConnectorEnrollmentId) })
      .toThrow(/"ghost" attached without a matching connector registration/)
  })
})
