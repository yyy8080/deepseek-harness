import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  DECLARED_CAPABILITIES_NOTICE,
  parsePluginManifest,
  parsePluginSection,
  PluginCapabilitiesSchema,
  pluginId,
  PluginManifestError,
  PluginSectionSchema,
  readPluginManifest,
} from '@deepseek-ai/dsh-plugin-manifest'

const capabilities = { tools: ['hello'], filesystem: 'read', network: 'none', subprocess: false } as const

const section = {
  displayName: 'Hello',
  description: 'greets',
  publisher: 'examples',
  capabilities,
}

/** Write a package.json into a fresh directory and return that directory. */
function packageDir(manifest: unknown): string {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-plugin-manifest-'))
  writeFileSync(join(dir, 'package.json'), JSON.stringify(manifest))
  return dir
}

describe('capability schema', () => {
  it('accepts every declared access level', () => {
    for (const level of ['none', 'read', 'write'] as const) {
      expect(PluginCapabilitiesSchema({ ...capabilities, filesystem: level, network: level }))
        .toMatchObject({ filesystem: level, network: level })
    }
  })

  it('rejects an unknown access level', () => {
    expect(() => parsePluginSection(
      { ...section, capabilities: { ...capabilities, network: 'inbound' } },
      'catalog',
    )).toThrow(PluginManifestError)
  })

  it('rejects a missing capabilities block', () => {
    expect(() => parsePluginSection({ ...section, capabilities: undefined }, 'catalog'))
      .toThrow(/\$\.capabilities missing required value/)
  })
})

describe('section schema', () => {
  it('accepts a complete section and keeps the optional homepage', () => {
    const parsed = PluginSectionSchema({ ...section, homepage: 'https://example.test' })
    expect(parsed.homepage).toBe('https://example.test')
    expect(parsed.capabilities.tools).toEqual(['hello'])
  })

  it('keeps only the declared fields, so a catalog row cannot smuggle its own keys through', () => {
    expect(parsePluginSection(
      { ...section, homepage: 'https://example.test', releases: [{ version: '1.0.0' }], rating: 5 },
      'catalog',
    )).toEqual({ ...section, homepage: 'https://example.test' })
  })

  it('names the source and the failing field', () => {
    expect(() => parsePluginSection({ ...section, publisher: undefined }, '/tmp/x/package.json'))
      .toThrow(/^\/tmp\/x\/package\.json: invalid dsh\.plugin section: .*publisher/)
  })

  it('reports a non-Error validation failure as its string form', () => {
    expect(() => parsePluginSection(7, 'catalog')).toThrow(PluginManifestError)
  })
})

describe('parsePluginManifest', () => {
  it('joins a package name to the validated section', () => {
    expect(parsePluginManifest({ ...section, id: 'dsh-plugin-hello' }, 'catalog'))
      .toEqual({ ...section, id: 'dsh-plugin-hello' })
  })

  it('rejects an entry with no id', () => {
    expect(() => parsePluginManifest(section, 'catalog')).toThrow(/declares no package name in "id"/)
  })

  it('rejects an entry with a blank id', () => {
    expect(() => parsePluginManifest({ ...section, id: '' }, 'catalog')).toThrow(/declares no package name/)
  })

  it('rejects a non-object entry', () => {
    expect(() => parsePluginManifest(null, 'catalog')).toThrow(/declares no package name/)
  })
})

describe('readPluginManifest', () => {
  it('reads the dsh.plugin section of a package directory', () => {
    const dir = packageDir({ name: 'dsh-plugin-hello', dsh: { plugin: section } })
    expect(readPluginManifest(dir)).toEqual({ ...section, id: 'dsh-plugin-hello' })
  })

  it('reports a package that declares no dsh.plugin section', () => {
    expect(readPluginManifest(packageDir({ name: 'plain-library' }))).toBeUndefined()
    expect(readPluginManifest(packageDir({ name: 'bundle-only', dsh: { bundle: { patch: './p.yml' } } })))
      .toBeUndefined()
  })

  it('rejects a package that declares dsh.plugin without a name', () => {
    expect(() => readPluginManifest(packageDir({ dsh: { plugin: section } })))
      .toThrow(/declares dsh\.plugin but no package name/)
    expect(() => readPluginManifest(packageDir({ name: '', dsh: { plugin: section } })))
      .toThrow(/declares dsh\.plugin but no package name/)
  })

  it('rejects an unreadable package manifest', () => {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-plugin-manifest-'))
    expect(() => readPluginManifest(dir)).toThrow(/cannot read package manifest/)
    writeFileSync(join(dir, 'package.json'), '{ not json')
    expect(() => readPluginManifest(dir)).toThrow(/cannot read package manifest/)
  })

  it('propagates an invalid section with the manifest path', () => {
    const dir = packageDir({ name: 'dsh-plugin-hello', dsh: { plugin: { ...section, description: undefined } } })
    expect(() => readPluginManifest(dir)).toThrow(new RegExp(`^${dir.replace(/\\/g, '\\\\')}`))
  })
})

describe('vocabulary', () => {
  it('brands a package name without changing it', () => {
    expect(pluginId('dsh-plugin-hello')).toBe('dsh-plugin-hello')
  })

  it('states that declared capabilities are not enforced', () => {
    expect(DECLARED_CAPABILITIES_NOTICE).toMatch(/not enforced/)
  })
})
