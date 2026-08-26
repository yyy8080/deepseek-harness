/**
 * Tests for the connector package's runtime invariant: every announced link
 * belongs to a registration that authorized it, describing the same machine.
 */

import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import InvariantRegistry, { InvariantError } from '@deepseek-ai/dsh-invariants'
import ConnectorRegistry, { ConnectorId } from '@deepseek-ai/dsh-connector'
import type { ConnectorDescriptor, ConnectorLink, ConnectorOs } from '@deepseek-ai/dsh-connector'
import * as ConnectorInvariant from '@deepseek-ai/dsh-connector/invariant'

function descriptor(id: string, os: ConnectorOs = 'linux'): ConnectorDescriptor {
  return { id: ConnectorId(id), os, workdir: '/srv/work' }
}

async function setup(): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(ConnectorRegistry, {})
  await ctx.plugin(InvariantRegistry, { enabled: true })
  await ctx.plugin(ConnectorInvariant)
  return ctx
}

function register(ctx: Context, of: ConnectorDescriptor): void {
  ctx.connectors.register(of, async () => ({
    descriptor: of,
    files: {} as ConnectorLink['files'],
    processes: {} as ConnectorLink['processes'],
    close: async () => undefined,
  }))
}

describe('connector invariants', () => {
  it('accepts a link announced for its own registration', async () => {
    const ctx = await setup()
    const only = descriptor('build-linux')
    register(ctx, only)

    expect(() => { ctx.emit('connector/link-opened', only) }).not.toThrow()
  })

  it('rejects a link announced for an unregistered connector', async () => {
    const ctx = await setup()

    expect(() => { ctx.emit('connector/link-opened', descriptor('ghost')) })
      .toThrow(new InvariantError('@deepseek-ai/dsh-connector', 'connector ghost opened a link while unregistered'))
  })

  it('rejects a link whose OS family disagrees with its registration', async () => {
    const ctx = await setup()
    register(ctx, descriptor('build-linux'))

    expect(() => { ctx.emit('connector/link-opened', descriptor('build-linux', 'windows')) })
      .toThrow(new InvariantError(
        '@deepseek-ai/dsh-connector',
        'connector build-linux opened a windows link while registered as linux',
      ))
  })
})
