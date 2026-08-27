/**
 * Connectors section registration: the slot declaration it waits for, the
 * locale-following nav label, the Remote calls it hands the page, and the
 * conversation entry it only offers where a sessions domain is mounted.
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

const SNAPSHOT = { enrollments: [], chat: { ready: true, agentPreset: 'connector' } }

const REPORT = {
  alive: true,
  enrollmentId: 'enrol-1',
  probedAt: 0,
  latencyMs: 9,
  resolvedWorkdir: '/srv/work',
  workdirIsDirectory: true,
}

/** One attached machine, as the page hands it to the conversation entry. */
const MACHINE = {
  enrollmentId: 'enrol-1',
  connectorId: 'enrol-1',
  os: 'linux',
  status: 'attached',
  label: 'build-box',
  workdir: '/srv/work',
  issuedAt: 0,
  expiresAt: 0,
} as unknown as Parameters<NonNullable<ConnectorsSectionInjected['startChat']>>[0]

async function bench(options: { sessions?: boolean } = {}) {
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
    list: vi.fn<() => Promise<Answer<typeof SNAPSHOT>>>().mockResolvedValue({ ok: true, value: SNAPSHOT }),
    revoke: vi.fn<() => Promise<Answer<{ revoked: boolean }>>>().mockResolvedValue({ ok: true, value: { revoked: true } }),
    probe: vi.fn<() => Promise<Answer<typeof REPORT>>>().mockResolvedValue({ ok: true, value: REPORT }),
  }
  ctx.provide('remote.connectorPortal', portal)
  const startConnectorSession = vi.fn<(opts: unknown) => Promise<string>>().mockResolvedValue('session-1')
  if (options.sessions === true) ctx.provide('sessions', { startConnectorSession } as never)
  return { ctx, slots: ctx.get('slots') as SlotRegistry, locale, portal, startConnectorSession }
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
    await expect(face.list()).resolves.toEqual(SNAPSHOT)
    await expect(face.revoke('enrol-1' as never)).resolves.toBeUndefined()
    await expect(face.probe('enrol-1' as never)).resolves.toEqual(REPORT)

    expect(b.portal.issue).toHaveBeenCalledWith({ os: 'linux' })
    expect(b.portal.revoke).toHaveBeenCalledWith({ enrollmentId: 'enrol-1' })
    expect(b.portal.probe).toHaveBeenCalledWith({ enrollmentId: 'enrol-1' })
    await b.ctx.fiber.dispose()
  })

  it('offers no conversation entry where no sessions domain is mounted', async () => {
    const b = await bench()
    declare(b.slots)
    await b.ctx.plugin({ inject: [...inject], apply }).await()
    stubBrowser()

    expect(injected(b.slots).startChat).toBeUndefined()
    await b.ctx.fiber.dispose()
  })

  it('starts a conversation on the machine in the target\u2019s own working directory', async () => {
    const b = await bench({ sessions: true })
    declare(b.slots)
    await b.ctx.plugin({ inject: [...inject], apply }).await()
    stubBrowser()

    await injected(b.slots).startChat?.(MACHINE, 'connector')

    expect(b.startConnectorSession)
      .toHaveBeenCalledWith({ connectorId: 'enrol-1', agentPreset: 'connector', cwd: '/srv/work' })
    await b.ctx.fiber.dispose()
  })

  it.each([
    ['issue', (face: ConnectorsSectionInjected) => face.issue('linux')],
    ['list', (face: ConnectorsSectionInjected) => face.list()],
    ['revoke', (face: ConnectorsSectionInjected) => face.revoke('enrol-1' as never)],
    ['probe', (face: ConnectorsSectionInjected) => face.probe('enrol-1' as never)],
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
