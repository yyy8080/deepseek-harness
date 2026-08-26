/**
 * Tests for the TCP transport plugin: how a deployment's declarations become
 * registry entries, and how each one's shared secret is resolved.
 */

import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import ConnectorRegistry from '@deepseek-ai/dsh-connector'
import { hostConnectorOs, serveConnector } from '@deepseek-ai/dsh-connector-host'
import * as ConnectorTcp from '@deepseek-ai/dsh-connector-tcp'
import { resolveConnectorToken } from '@deepseek-ai/dsh-connector-tcp'
import type { ConnectorTcpDeclaration } from '@deepseek-ai/dsh-connector-tcp'

const declaration: ConnectorTcpDeclaration = {
  id: 'lab-windows',
  host: '127.0.0.1',
  port: 8765,
  os: 'windows',
  workdir: String.raw`C:\work`,
  tokenEnv: 'DSH_LAB_TOKEN',
}

afterEach(() => { vi.unstubAllEnvs() })

async function mounted(
  config: { connectors?: ConnectorTcpDeclaration[] },
  registry: { default?: string } = {},
): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(ConnectorRegistry, registry)
  await ctx.plugin(ConnectorTcp, config)
  return ctx
}

describe('token resolution', () => {
  it('reads the secret from the named environment variable', () => {
    expect(resolveConnectorToken(declaration, { DSH_LAB_TOKEN: 'from-env' })).toBe('from-env')
  })

  it('accepts an inline secret for a deployment that manages the file as one', () => {
    expect(resolveConnectorToken({ ...declaration, tokenEnv: undefined, token: 'inline' }, {})).toBe('inline')
  })

  it.each([
    [{ ...declaration, token: 'both' }, 'needs exactly one of token or tokenEnv'],
    [{ ...declaration, tokenEnv: undefined }, 'needs exactly one of token or tokenEnv'],
    [{ ...declaration, tokenEnv: undefined, token: '' }, 'has an empty token'],
  ])('rejects declaration %#', (invalid, detail) => {
    expect(() => resolveConnectorToken(invalid, {})).toThrow(detail)
  })

  it('rejects an environment variable that is unset or empty', () => {
    expect(() => resolveConnectorToken(declaration, {})).toThrow(/reads its token from DSH_LAB_TOKEN, which is unset/)
    expect(() => resolveConnectorToken(declaration, { DSH_LAB_TOKEN: '' })).toThrow(/unset or empty/)
  })
})

describe('registration', () => {
  it('registers nothing when a deployment declares no connectors', async () => {
    expect((await mounted({})).connectors.list()).toEqual([])
  })

  it('registers every declaration with the machine it names', async () => {
    vi.stubEnv('DSH_LAB_TOKEN', 'from-env')

    const ctx = await mounted({
      connectors: [declaration, { ...declaration, id: 'build-linux', os: 'linux', workdir: '/srv/work' }],
    })

    expect(ctx.connectors.list()).toEqual([
      { id: 'lab-windows', os: 'windows', workdir: String.raw`C:\work` },
      { id: 'build-linux', os: 'linux', workdir: '/srv/work' },
    ])
  })

  it('fails to load when a declaration cannot resolve its secret', async () => {
    await expect(mounted({ connectors: [declaration] })).rejects.toThrow(/reads its token from DSH_LAB_TOKEN/)
  })

  it('opens a declared connector against the agent it names', async () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), 'dsh-connector-declared-')))
    const agent = await serveConnector({ host: '127.0.0.1', port: 0, token: 'from-env', workdir: dir })
    vi.stubEnv('DSH_LAB_TOKEN', 'from-env')
    const ctx = await mounted(
      { connectors: [{ ...declaration, id: 'declared', os: hostConnectorOs(), workdir: dir, port: agent.port }] },
      { default: 'declared' },
    )

    const link = await ctx.connectors.link()

    expect(link.descriptor).toEqual({ id: 'declared', os: hostConnectorOs(), workdir: dir })
    await link.close()
    await agent.close()
    rmSync(dir, { recursive: true, force: true })
  })
})
