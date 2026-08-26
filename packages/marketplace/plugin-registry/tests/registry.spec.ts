import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it } from 'vitest'
import { pluginId, type PluginManifest } from '@deepseek-ai/dsh-plugin-manifest'
import PluginRegistry, {
  PluginRegistryError,
  type PluginCatalogProvider,
  type PluginListing,
} from '@deepseek-ai/dsh-plugin-registry'

/** Build a listing with one release per supplied version, newest first. */
function listing(id: string, versions: readonly string[], overrides: Partial<PluginManifest> = {}): PluginListing {
  return {
    manifest: {
      id: pluginId(id),
      displayName: `Display ${id}`,
      description: `describes ${id}`,
      publisher: 'examples',
      capabilities: { tools: [], filesystem: 'none', network: 'none', subprocess: false },
      ...overrides,
    },
    releases: versions.map(version => ({ version, tarball: `/tarballs/${id}-${version}.tgz` })),
  }
}

/** A provider answering with a fixed catalog and recording the signal it was handed. */
function fixedProvider(id: string, listings: readonly PluginListing[]): PluginCatalogProvider & { signals: (AbortSignal | undefined)[] } {
  const signals: (AbortSignal | undefined)[] = []
  return {
    id,
    signals,
    catalog: (signal?: AbortSignal) => {
      signals.push(signal)
      return Promise.resolve(listings)
    },
  }
}

/** Mount the seam on a fresh context. */
async function mount(): Promise<{ ctx: Context; registry: PluginRegistry }> {
  const ctx = new Context()
  await ctx.plugin(PluginRegistry)
  return { ctx, registry: ctx.pluginRegistry }
}

describe('provider registration', () => {
  it('rejects a duplicate provider id', async () => {
    const { ctx, registry } = await mount()
    registry.registerProvider(fixedProvider('static', []))
    expect(() => registry.registerProvider(fixedProvider('static', [])))
      .toThrow(/already registered/)
    await ctx.fiber.dispose()
  })

  it('unregisters on its own disposer', async () => {
    const { ctx, registry } = await mount()
    const dispose = registry.registerProvider(fixedProvider('static', [listing('a', ['1.0.0'])]))
    await expect(registry.search()).resolves.toHaveLength(1)
    dispose()
    await expect(registry.search()).rejects.toThrow(/no plugin catalog provider is registered/)
    await ctx.fiber.dispose()
  })

  it('unregisters when the contributing fiber is disposed', async () => {
    const { ctx, registry } = await mount()
    const fiber = ctx.plugin({
      inject: ['pluginRegistry'],
      apply: (child: Context) => {
        child.pluginRegistry.registerProvider(fixedProvider('static', [listing('a', ['1.0.0'])]))
      },
    })
    await fiber.await()
    await expect(registry.search()).resolves.toHaveLength(1)
    await fiber.dispose()
    await expect(registry.search()).rejects.toThrow(/no plugin catalog provider is registered/)
    await ctx.fiber.dispose()
  })
})

describe('catalog aggregation', () => {
  it('merges every registered provider and forwards the cancellation signal', async () => {
    const { ctx, registry } = await mount()
    const first = fixedProvider('first', [listing('a', ['1.0.0'])])
    const second = fixedProvider('second', [listing('b', ['2.0.0'])])
    registry.registerProvider(first)
    registry.registerProvider(second)
    const signal = AbortSignal.abort.call(AbortSignal, 'unused') as AbortSignal
    const merged = await registry.catalog(signal)
    expect([...merged.keys()]).toEqual(['a', 'b'])
    expect(first.signals).toEqual([signal])
    expect(second.signals).toEqual([signal])
    await ctx.fiber.dispose()
  })

  it('rejects one plugin listed by two providers', async () => {
    const { ctx, registry } = await mount()
    registry.registerProvider(fixedProvider('first', [listing('a', ['1.0.0'])]))
    registry.registerProvider(fixedProvider('second', [listing('a', ['1.1.0'])]))
    await expect(registry.catalog()).rejects.toThrow(/listed by both catalog providers "first" and "second"/)
    await ctx.fiber.dispose()
  })

  it('rejects a listing with no release', async () => {
    const { ctx, registry } = await mount()
    registry.registerProvider(fixedProvider('first', [listing('a', [])]))
    await expect(registry.catalog()).rejects.toThrow(/lists plugin "a" with no release/)
    await ctx.fiber.dispose()
  })

  it('reports the absence of any provider with a routable code', async () => {
    const { ctx, registry } = await mount()
    await expect(registry.catalog()).rejects.toMatchObject({ code: 'PLUGIN_REGISTRY_UNAVAILABLE' })
    await ctx.fiber.dispose()
  })
})

describe('search', () => {
  it('matches name, display name, description, and publisher case-insensitively', async () => {
    const { ctx, registry } = await mount()
    registry.registerProvider(fixedProvider('static', [
      listing('dsh-plugin-alpha', ['1.0.0'], { displayName: 'Alpha Tools' }),
      listing('dsh-plugin-beta', ['1.0.0'], { publisher: 'Acme' }),
      listing('dsh-plugin-gamma', ['1.0.0'], { description: 'wraps ALPHA output' }),
    ]))
    expect((await registry.search({ text: 'alpha' })).map(found => found.manifest.id))
      .toEqual(['dsh-plugin-alpha', 'dsh-plugin-gamma'])
    expect((await registry.search({ text: 'acme' })).map(found => found.manifest.id))
      .toEqual(['dsh-plugin-beta'])
    await ctx.fiber.dispose()
  })

  it('returns every listing sorted by name when the query has no text', async () => {
    const { ctx, registry } = await mount()
    registry.registerProvider(fixedProvider('static', [listing('zeta', ['1.0.0']), listing('alpha', ['1.0.0'])]))
    expect((await registry.search()).map(found => found.manifest.id)).toEqual(['alpha', 'zeta'])
    expect((await registry.search({ text: '' })).map(found => found.manifest.id)).toEqual(['alpha', 'zeta'])
    await ctx.fiber.dispose()
  })

  it('caps the result at the requested limit', async () => {
    const { ctx, registry } = await mount()
    registry.registerProvider(fixedProvider('static', [listing('a', ['1.0.0']), listing('b', ['1.0.0'])]))
    expect(await registry.search({ limit: 1 })).toHaveLength(1)
    expect(await registry.search({ limit: 5 })).toHaveLength(2)
    await ctx.fiber.dispose()
  })
})

describe('lookup and updates', () => {
  it('returns a listing by id and undefined for an unlisted one', async () => {
    const { ctx, registry } = await mount()
    registry.registerProvider(fixedProvider('static', [listing('a', ['1.0.0'])]))
    expect((await registry.get(pluginId('a')))?.manifest.displayName).toBe('Display a')
    expect(await registry.get(pluginId('missing'))).toBeUndefined()
    await ctx.fiber.dispose()
  })

  it('lists releases newest first and rejects an unlisted id', async () => {
    const { ctx, registry } = await mount()
    registry.registerProvider(fixedProvider('static', [listing('a', ['2.0.0', '1.0.0'])]))
    expect((await registry.versions(pluginId('a'))).map(release => release.version)).toEqual(['2.0.0', '1.0.0'])
    await expect(registry.versions(pluginId('missing')))
      .rejects.toMatchObject({ code: 'PLUGIN_REGISTRY_UNKNOWN_PLUGIN' })
    await ctx.fiber.dispose()
  })

  it('reports installed versions that differ from the newest release and skips unlisted ones', async () => {
    const { ctx, registry } = await mount()
    registry.registerProvider(fixedProvider('static', [listing('a', ['2.0.0', '1.0.0']), listing('b', ['1.0.0'])]))
    expect(await registry.updates([
      { id: pluginId('a'), version: '1.0.0' },
      { id: pluginId('b'), version: '1.0.0' },
      { id: pluginId('hand-installed'), version: '0.0.1' },
    ])).toEqual([{ id: 'a', installed: '1.0.0', latest: { version: '2.0.0', tarball: '/tarballs/a-2.0.0.tgz' } }])
    await ctx.fiber.dispose()
  })
})

describe('error taxonomy', () => {
  it('carries a machine-routable code and the class name', () => {
    const error = new PluginRegistryError('boom', 'PLUGIN_REGISTRY_UNAVAILABLE')
    expect(error.code).toBe('PLUGIN_REGISTRY_UNAVAILABLE')
    expect(error.name).toBe('PluginRegistryError')
  })
})
