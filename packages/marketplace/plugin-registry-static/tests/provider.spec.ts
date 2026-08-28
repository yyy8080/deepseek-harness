import { createServer, type Server } from 'node:http'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { isAbsolute, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import type { AddressInfo } from 'node:net'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import PluginRegistry from '@deepseek-ai/dsh-plugin-registry'
import * as staticCatalog from '@deepseek-ai/dsh-plugin-registry-static'
import { StaticPluginCatalogProvider } from '@deepseek-ai/dsh-plugin-registry-static'

/** One catalog entry with a single release, ready to embed in an index document. */
const ENTRY = {
  id: 'dsh-plugin-hello',
  displayName: 'Hello',
  description: 'greets',
  publisher: 'examples',
  capabilities: { tools: ['hello'], filesystem: 'none', network: 'none', subprocess: false },
  releases: [{ version: '1.0.0', tarball: './dsh-plugin-hello-1.0.0.tgz', publishedAt: '2026-01-01T00:00:00.000Z' }],
}

/** An index document holding the supplied entries at the supported version. */
function document(plugins: readonly unknown[], version = 1): string {
  return JSON.stringify({ version, plugins })
}

const roots: string[] = []
const servers: Server[] = []

afterEach(async () => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
  await Promise.all(servers.splice(0).map(server => new Promise<void>(resolve => server.close(() => { resolve() }))))
})

/** Write an index document into a fresh directory. */
function indexFile(text: string, name = 'index.json'): { path: string; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-static-catalog-'))
  roots.push(dir)
  const path = join(dir, name)
  writeFileSync(path, text)
  return { path, dir }
}

/** Serve one index document over HTTP and return its origin. */
async function indexServer(handle: (url: string) => { status: number; body: string; location?: string }): Promise<string> {
  const server = createServer((request, response) => {
    const { status, body, location } = handle(request.url ?? '/')
    response.writeHead(status, location === undefined ? {} : { location })
    response.end(body)
  })
  servers.push(server)
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', () => { resolve() }))
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`
}

describe('filesystem index', () => {
  it('reads a relative path against the configured base and resolves tarballs beside the index', async () => {
    const { dir } = indexFile(document([ENTRY]))
    const provider = new StaticPluginCatalogProvider({ index: 'index.json', base: dir })

    const [listing] = await provider.catalog()

    expect(provider.id).toBe('static')
    expect(listing?.manifest).toEqual({
      id: 'dsh-plugin-hello',
      displayName: 'Hello',
      description: 'greets',
      publisher: 'examples',
      capabilities: ENTRY.capabilities,
    })
    expect(listing?.releases).toEqual([{
      version: '1.0.0',
      tarball: join(dir, 'dsh-plugin-hello-1.0.0.tgz'),
      publishedAt: '2026-01-01T00:00:00.000Z',
    }])
  })

  it('reads an absolute path and a file URL', async () => {
    const { path, dir } = indexFile(document([ENTRY]))

    for (const index of [path, pathToFileURL(path).href]) {
      const listings = await new StaticPluginCatalogProvider({ index, base: dir }).catalog()
      expect(listings.map(listing => listing.manifest.id)).toEqual(['dsh-plugin-hello'])
    }
  })

  it('keeps an absolute or remote tarball location as the index wrote it', async () => {
    const absolute = isAbsolute('/tarballs/pinned.tgz') ? '/tarballs/pinned.tgz' : 'C:\\tarballs\\pinned.tgz'
    const { dir } = indexFile(document([{
      ...ENTRY,
      releases: [
        { version: '2.0.0', tarball: absolute },
        { version: '1.0.0', tarball: 'https://cdn.test/dsh-plugin-hello-1.0.0.tgz' },
      ],
    }]))

    const [listing] = await new StaticPluginCatalogProvider({ index: 'index.json', base: dir }).catalog()

    expect(listing?.releases.map(release => release.tarball))
      .toEqual([absolute, 'https://cdn.test/dsh-plugin-hello-1.0.0.tgz'])
  })

  it('reports an index file that cannot be read', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-static-catalog-'))
    roots.push(dir)

    await expect(new StaticPluginCatalogProvider({ index: 'absent.json', base: dir }).catalog())
      .rejects.toMatchObject({ code: 'PLUGIN_CATALOG_UNREADABLE' })
  })
})

describe('index validation', () => {
  it('reports a document that is not JSON', async () => {
    const { dir } = indexFile('{ not json')

    await expect(new StaticPluginCatalogProvider({ index: 'index.json', base: dir }).catalog())
      .rejects.toThrow(/not a valid marketplace index document/)
  })

  it('reports a document missing the frame fields', async () => {
    const { dir } = indexFile(JSON.stringify({ plugins: [] }))

    await expect(new StaticPluginCatalogProvider({ index: 'index.json', base: dir }).catalog())
      .rejects.toMatchObject({ code: 'PLUGIN_CATALOG_INVALID' })
  })

  it('refuses an index document version it does not know', async () => {
    const { dir } = indexFile(document([], 2))

    await expect(new StaticPluginCatalogProvider({ index: 'index.json', base: dir }).catalog())
      .rejects.toThrow(/index version 2 is not supported \(expected 1\)/)
  })

  it('names the plugin whose manifest fields are invalid', async () => {
    const { dir } = indexFile(document([{ ...ENTRY, publisher: undefined }]))

    await expect(new StaticPluginCatalogProvider({ index: 'index.json', base: dir }).catalog())
      .rejects.toThrow(/invalid dsh\.plugin section/)
  })

  it('names the plugin whose release list is invalid', async () => {
    const { dir } = indexFile(document([{ ...ENTRY, releases: [{ version: '1.0.0' }] }]))

    await expect(new StaticPluginCatalogProvider({ index: 'index.json', base: dir }).catalog())
      .rejects.toThrow(/plugin "dsh-plugin-hello" has an invalid releases list/)
  })
})

describe('HTTP index', () => {
  it('resolves a relative tarball against the index URL', async () => {
    const origin = await indexServer(() => ({ status: 200, body: document([ENTRY]) }))

    const [listing] = await new StaticPluginCatalogProvider({
      index: `${origin}/catalog/index.json`, base: process.cwd(),
    }).catalog()

    expect(listing?.releases[0]?.tarball).toBe(`${origin}/catalog/dsh-plugin-hello-1.0.0.tgz`)
  })

  it('keeps an absolute tarball URL the index publishes', async () => {
    const origin = await indexServer(() => ({
      status: 200,
      body: document([{ ...ENTRY, releases: [{ version: '1.0.0', tarball: 'https://cdn.test/p.tgz' }] }]),
    }))

    const [listing] = await new StaticPluginCatalogProvider({ index: `${origin}/index.json`, base: process.cwd() }).catalog()

    expect(listing?.releases[0]?.tarball).toBe('https://cdn.test/p.tgz')
  })

  it('reports a non-success response', async () => {
    const origin = await indexServer(() => ({ status: 404, body: 'missing' }))

    await expect(new StaticPluginCatalogProvider({ index: `${origin}/index.json`, base: process.cwd() }).catalog())
      .rejects.toThrow(/marketplace index request failed with HTTP 404/)
  })

  it('refuses to follow a redirect off the configured origin', async () => {
    const origin = await indexServer(() => ({ status: 302, body: '', location: 'https://elsewhere.test/index.json' }))

    await expect(new StaticPluginCatalogProvider({ index: `${origin}/index.json`, base: process.cwd() }).catalog())
      .rejects.toMatchObject({ code: 'PLUGIN_CATALOG_UNREADABLE' })
  })

  it('forwards the caller cancellation signal', async () => {
    const origin = await indexServer(() => ({ status: 200, body: document([ENTRY]) }))
    const controller = new AbortController()
    controller.abort()

    await expect(new StaticPluginCatalogProvider({ index: `${origin}/index.json`, base: process.cwd() })
      .catalog(controller.signal)).rejects.toMatchObject({ code: 'PLUGIN_CATALOG_UNREADABLE' })
  })
})

describe('plugin registration', () => {
  it('registers the provider into the seam and resolves relative paths against the configured base', async () => {
    const { dir } = indexFile(document([ENTRY]))
    const ctx = new Context()
    await ctx.plugin(PluginRegistry)

    const fiber = ctx.plugin(staticCatalog, staticCatalog.Config({ index: 'index.json', base: dir }))
    await fiber.await()

    expect((await ctx.pluginRegistry.search()).map(listing => listing.manifest.id)).toEqual(['dsh-plugin-hello'])
    await fiber.dispose()
    await expect(ctx.pluginRegistry.search()).rejects.toThrow(/no plugin catalog provider is registered/)
    await ctx.fiber.dispose()
  })

  it('resolves a relative index against the process working directory when no base is configured', async () => {
    const { dir } = indexFile(document([ENTRY]))
    mkdirSync(join(dir, 'nested'), { recursive: true })
    const ctx = new Context()
    await ctx.plugin(PluginRegistry)
    const previous = process.cwd()
    process.chdir(dir)
    try {
      const fiber = ctx.plugin(staticCatalog, staticCatalog.Config({ index: 'index.json' }))
      await fiber.await()
      expect((await ctx.pluginRegistry.search()).map(listing => listing.manifest.id)).toEqual(['dsh-plugin-hello'])
    } finally {
      process.chdir(previous)
    }
    await ctx.fiber.dispose()
  })
})
