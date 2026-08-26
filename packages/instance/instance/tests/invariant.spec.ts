import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import InvariantRegistry from '@deepseek-ai/dsh-invariants'
import { InstanceId, type InstanceView } from '@deepseek-ai/dsh-instance'
import * as InstanceInvariant from '@deepseek-ai/dsh-instance/invariant'

const RUNNING: InstanceView = {
  id: InstanceId('inst-1'),
  label: 'alpha',
  provider: 'scripted',
  desired: 'running',
  lifecycle: 'running',
  endpoint: { origin: 'http://127.0.0.1:4001', root: '/tmp/inst-1' },
}

/**
 * Mount the companion over a registry stand-in whose snapshot the test owns,
 * and return the announcer that feeds it the authoritative stream.
 */
async function setup(seed: InstanceView[] = []): Promise<(view: InstanceView) => void> {
  const ctx = new Context()
  const registry = {
    list: () => seed,
    get: (id: string) => seed.find(view => view.id === id),
  }
  await ctx.plugin(InvariantRegistry)
  await ctx.plugin({
    name: 'instance-invariant-probe',
    apply(child: Context) { child.provide('instances', registry as never) },
  })
  await ctx.plugin(InstanceInvariant)
  return (view) => { ctx.emit('instance/changed', view) }
}

describe('instance-registry invariants', () => {
  it('accepts a running instance with an endpoint and a stopped one without', async () => {
    const announce = await setup([RUNNING])
    expect(() => { announce(RUNNING) }).not.toThrow()
    expect(() => {
      announce({ ...RUNNING, id: InstanceId('inst-2'), lifecycle: 'stopped', endpoint: undefined })
    }).not.toThrow()
  })

  it.each([
    [{ ...RUNNING, lifecycle: 'stopped' } as InstanceView, /announced lifecycle stopped with an endpoint/],
    [{ ...RUNNING, endpoint: undefined } as InstanceView, /announced lifecycle running without an endpoint/],
    [
      { ...RUNNING, lifecycle: 'stopping', endpoint: undefined, failure: 'boom' } as InstanceView,
      /carrying a failure/,
    ],
  ])('rejects an announcement that breaks the endpoint or failure contract', async (view, message) => {
    const announce = await setup()
    expect(() => { announce(view) }).toThrow(message)
  })

  it('rejects an announcement the registry snapshot contradicts', async () => {
    const announce = await setup([RUNNING])
    expect(() => { announce({ ...RUNNING, lifecycle: 'stopped', endpoint: undefined }) })
      .toThrow(/announced stopped while the registry holds running/)
  })

  it('rejects an incoherent instance already present at installation', async () => {
    await expect(setup([{ ...RUNNING, lifecycle: 'starting' }])).rejects.toThrow(/with an endpoint/)
  })
})
