/**
 * Tests for the in-process local connector plugin: what it registers, and the
 * link it opens on first use.
 */

import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import ConnectorRegistry from '@deepseek-ai/dsh-connector'
import * as ConnectorHost from '@deepseek-ai/dsh-connector-host'
import { hostConnectorOs } from '@deepseek-ai/dsh-connector-host'

async function mounted(config: { id?: string; workdir?: string } = {}): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(ConnectorRegistry, { default: config.id ?? 'local' })
  await ctx.plugin(ConnectorHost, config)
  return ctx
}

describe('the local connector', () => {
  it('registers this machine under the default id and cwd', async () => {
    const ctx = await mounted()

    expect(ctx.connectors.list()).toEqual([{ id: 'local', os: hostConnectorOs(), workdir: resolve(process.cwd()) }])
  })

  it('takes its id and an absolute workdir from configuration', async () => {
    const ctx = await mounted({ id: 'build', workdir: '/srv/work/../work' })

    expect(ctx.connectors.list()).toEqual([{ id: 'build', os: hostConnectorOs(), workdir: resolve('/srv/work') }])
  })

  it('opens a link that serves this machine', async () => {
    const ctx = await mounted({ id: 'build', workdir: process.cwd() })

    const link = await ctx.connectors.link()

    expect(link.descriptor.id).toBe('build')
    await expect(link.files.resolve('.', undefined, undefined))
      .resolves.toMatchObject({ targetKey: resolve(process.cwd()) })
  })
})
