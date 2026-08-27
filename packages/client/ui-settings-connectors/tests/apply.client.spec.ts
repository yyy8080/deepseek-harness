/**
 * Connectors section registration: the slot declaration it waits for, the
 * locale-following nav label, and the three Remote calls it hands the page.
 */

import { Context, Service } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { resolveSlotLabel } from '@deepseek-ai/dsh-client-ui-slots'
import { SlotRegistry } from '@deepseek-ai/dsh-client-runtime/client'
import { LocaleRuntime } from '@deepseek-ai/dsh-client-locale/client'
import { apply, inject, NS } from '../src/client/index.ts'
import { ConnectorsSection } from '../src/client/ConnectorsSection.tsx'
import type { ConnectorsSectionInjected } from '../src/client/ConnectorsSection.tsx'

const TICKET = {
  enrollmentId: 'enrol-1',
  os: 'linux',
  downloadPath: '/connector/pack/enrol-1',
  installPath: '/connector/pack/enrol-1',
  fileName: 'dsh-connector.sh',
  expiresAt: 0,
}

/** One Remote answer, in the ok/err form the generated face returns. */
type Answer<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: { readonly code: string; readonly message: string } }

afterEach(() => { vi.unstubAllGlobals() })

/** The browser facts the injected face reads; this lane has no jsdom window. */
function stubBrowser(): { write: ReturnType<typeof vi.fn> } {
  const write = vi.fn<(text: string) => Promise<void>>().mockResolvedValue(undefined)
  vi.stubGlobal('location', { origin: 'https://harness.example.com' })
  vi.stubGlobal('navigator', { clipboard: { writeText: write } })
  return { write }
}

async function bench() {
  const ctx = new Context()
  await ctx.plugin(SlotRegistry).await()
  const locale = new LocaleRuntime(ctx)
  locale.setLocale('zh')
  ctx.provide('locale', locale)
  // The generated face hangs under `ctx.remote`, so the namespace has to be
  // provided against a real service rather than a plain object.
  class RemoteService extends Service {
    constructor(serviceCtx: Context) {
      super(serviceCtx, 'remote')
    }
  }
  new RemoteService(ctx)
  const portal = {
    issue: vi.fn<() => Promise<Answer<typeof TICKET>>>().mockResolvedValue({ ok: true, value: TICKET }),
    list: vi.fn<() => Promise<Answer<{ enrollments: [] }>>>().mockResolvedValue({ ok: true, value: { enrollments: [] } }),
    revoke: vi.fn<() => Promise<Answer<{ revoked: boolean }>>>().mockResolvedValue({ ok: true, value: { revoked: true } }),
  }
  ctx.provide('remote.connectorPortal', portal)
  return { ctx, slots: ctx.get('slots') as SlotRegistry, locale, portal }
}

function declare(slots: SlotRegistry): () => void {
  return slots.register(
    { name: 'root', children: { 'settings.section': { kind: 'list', scope: 'root' } } } as never,
    () => null,
  )
}

/** The injected face of the registered section. */
function injected(slots: SlotRegistry): ConnectorsSectionInjected {
  const entry = slots.entries('settings.section')[0]
  return (entry?.inject as unknown as () => ConnectorsSectionInjected)()
}

describe('ui-settings-connectors apply', () => {
  it('declares the services the Settings contribution uses', () => {
    expect(inject).toEqual(['slots', 'locale', 'remote', 'remote.connectorPortal'])
  })

  it('registers a locale-following Connectors page', async () => {
    const b = await bench()
    declare(b.slots)
    await b.ctx.plugin({ inject: [...inject], apply }).await()

    const entry = b.slots.entries('settings.section')[0]
    expect(entry?.component).toBe(ConnectorsSection)
    expect(entry?.options).toMatchObject({ id: 'connectors', order: 45 })
    expect(entry?.locale).toBe(NS)
    expect(resolveSlotLabel(entry?.options.label)).toBe('连接器')
    b.locale.setLocale('en')
    expect(resolveSlotLabel(entry?.options.label)).toBe('Connectors')
    await b.ctx.fiber.dispose()
  })

  it('reads the pack origin from the browser address and copies through the clipboard', async () => {
    const b = await bench()
    declare(b.slots)
    await b.ctx.plugin({ inject: [...inject], apply }).await()
    const { write } = stubBrowser()

    const face = injected(b.slots)
    await face.copy('curl -fsSL … | bash')

    expect(face.origin).toBe('https://harness.example.com')
    expect(write).toHaveBeenCalledWith('curl -fsSL … | bash')
    await b.ctx.fiber.dispose()
  })

  it('forwards each portal call and reports the answer', async () => {
    const b = await bench()
    declare(b.slots)
    await b.ctx.plugin({ inject: [...inject], apply }).await()
    stubBrowser()

    const face = injected(b.slots)
    await expect(face.issue('linux')).resolves.toEqual(TICKET)
    await expect(face.list()).resolves.toEqual({ enrollments: [] })
    await expect(face.revoke('enrol-1' as never)).resolves.toBeUndefined()

    expect(b.portal.issue).toHaveBeenCalledWith({ os: 'linux' })
    expect(b.portal.revoke).toHaveBeenCalledWith({ enrollmentId: 'enrol-1' })
    await b.ctx.fiber.dispose()
  })

  it.each([
    ['issue', (face: ConnectorsSectionInjected) => face.issue('linux')],
    ['list', (face: ConnectorsSectionInjected) => face.list()],
    ['revoke', (face: ConnectorsSectionInjected) => face.revoke('enrol-1' as never)],
  ])('names %s when the portal refuses it', async (method, call) => {
    const b = await bench()
    declare(b.slots)
    await b.ctx.plugin({ inject: [...inject], apply }).await()
    stubBrowser()
    b.portal[method as 'list'].mockResolvedValue({ ok: false, error: { code: 'REMOTE_ERROR', message: 'unavailable' } })

    await expect(call(injected(b.slots)))
      .rejects.toThrow(`connectorPortal.${method} failed: REMOTE_ERROR: unavailable`)
    await b.ctx.fiber.dispose()
  })
})
