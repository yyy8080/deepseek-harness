import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import InvariantRegistry from '@deepseek-ai/dsh-invariants'
import { InstanceId, type InstanceView } from '@deepseek-ai/dsh-instance'
import * as GatewayInvariant from '@deepseek-ai/dsh-instance-gateway/invariant'

const RUNNING: InstanceView = {
  id: InstanceId('inst-1'),
  label: 'alpha',
  provider: 'scripted',
  desired: 'running',
  lifecycle: 'running',
  endpoint: { origin: 'http://127.0.0.1:4001', root: '/tmp/inst-1' },
}

/** Mount the companion over a registry stand-in whose snapshot the test owns. */
async function setup(seed: InstanceView[] = []): Promise<(view: InstanceView) => void> {
  const ctx = new Context()
  await ctx.plugin(InvariantRegistry)
  await ctx.plugin({
    name: 'instance-gateway-invariant-probe',
    apply(child: Context) { child.provide('instances', { list: () => seed } as never) },
  })
  await ctx.plugin(GatewayInvariant)
  return (view) => { ctx.emit('instance/changed', view) }
}

describe('instance-gateway addressing invariants', () => {
  it('accepts an instance whose id and origin are routable', async () => {
    const announce = await setup([RUNNING])
    expect(() => { announce(RUNNING) }).not.toThrow()
  })

  it('rejects an instance id that global session ids would split on', async () => {
    const announce = await setup()
    expect(() => { announce({ ...RUNNING, id: InstanceId('inst~1') }) })
      .toThrow(/contains "~"/)
  })

  it('rejects an endpoint origin no client could resolve', async () => {
    const announce = await setup()
    expect(() => { announce({ ...RUNNING, endpoint: { origin: '127.0.0.1:4001', root: '/tmp' } }) })
      .toThrow(/published unroutable origin/)
  })

  it('checks the instances already registered when it installs', async () => {
    await expect(setup([{ ...RUNNING, id: InstanceId('inst~1') }])).rejects.toThrow(/contains "~"/)
  })
})
