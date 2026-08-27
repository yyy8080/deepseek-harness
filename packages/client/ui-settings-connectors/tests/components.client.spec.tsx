// @vitest-environment jsdom
/**
 * The Connectors page as a user drives it: picking a platform, copying the
 * command it generates, and watching the enrolled-machine list follow the
 * portal.
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { ConnectorsSection, installCommand } from '../src/client/ConnectorsSection.tsx'
import type { ConnectorsSectionInjected } from '../src/client/ConnectorsSection.tsx'
import { en } from '../src/client/locales.ts'
import type { ConnectorsLocaleKey } from '../src/client/locales.ts'

afterEach(cleanup)

const ORIGIN = 'https://harness.example.com'

const TICKET = {
  enrollmentId: 'enrol-1',
  os: 'linux',
  downloadPath: '/connector/pack/enrol-1',
  installPath: '/connector/pack/enrol-1',
  fileName: 'dsh-connector.sh',
  expiresAt: Date.parse('2026-08-26T12:00:00Z'),
} as unknown as Awaited<ReturnType<ConnectorsSectionInjected['issue']>>

type Snapshot = Awaited<ReturnType<ConnectorsSectionInjected['list']>>
type Enrollment = Snapshot['enrollments'][number]
type Report = Awaited<ReturnType<ConnectorsSectionInjected['probe']>>

/** The chat availability a deployment composed for connector work reports. */
const CHAT_READY = { ready: true, agentPreset: 'connector' } as const satisfies Snapshot['chat']

/** Spell one branded enrollment id, which only the host ever mints for real. */
function id(value: string): Enrollment['enrollmentId'] {
  return value as unknown as Enrollment['enrollmentId']
}

function machine(overrides: Partial<Enrollment> = {}): Enrollment {
  return {
    enrollmentId: 'enrol-1',
    connectorId: 'enrol-1',
    os: 'linux',
    status: 'attached',
    label: 'build-box',
    workdir: '/srv/work',
    issuedAt: 0,
    expiresAt: 0,
    ...overrides,
  } as Enrollment
}

/** One ledger read, defaulting to a deployment that can host connector chats. */
function snapshot(enrollments: Enrollment[] = [], chat: Snapshot['chat'] = CHAT_READY): Snapshot {
  return { enrollments, chat }
}

/** Render the page over stub dependencies and return the ones tests drive. */
function mount(overrides: Partial<ConnectorsSectionInjected> = {}) {
  const face: ConnectorsSectionInjected = {
    issue: vi.fn<ConnectorsSectionInjected['issue']>().mockResolvedValue(TICKET),
    list: vi.fn<ConnectorsSectionInjected['list']>().mockResolvedValue(snapshot()),
    revoke: vi.fn<ConnectorsSectionInjected['revoke']>().mockResolvedValue(undefined),
    probe: vi.fn<ConnectorsSectionInjected['probe']>()
      .mockResolvedValue({ alive: true, enrollmentId: id('enrol-1'), probedAt: 0, latencyMs: 12, resolvedWorkdir: '/srv/work', workdirIsDirectory: true } as Report),
    origin: ORIGIN,
    copy: vi.fn<ConnectorsSectionInjected['copy']>().mockResolvedValue(undefined),
    t: (key: ConnectorsLocaleKey, params?: Record<string, unknown>) =>
      en[key].replace(/\{(\w+)\}/g, (_match, name: string) => String(params?.[name])),
    ...overrides,
  }
  const view = render(<ConnectorsSection {...face} />)
  return Object.assign(face, { view })
}

/** A promise the test settles by hand. */
function deferred<T>(): { promise: Promise<T>; settle: (value: T) => void; fail: (reason: unknown) => void } {
  let settle!: (value: T) => void
  let fail!: (reason: unknown) => void
  const promise = new Promise<T>((resolve, reject) => { settle = resolve; fail = reject })
  return { promise, settle, fail }
}

describe('the install command', () => {
  it.each([
    ['linux', `curl -fsSL '${ORIGIN}/connector/pack/enrol-1' | bash`],
    ['windows', `irm '${ORIGIN}/connector/pack/enrol-1' | iex`],
  ])('is the %s one-liner for the same script the button downloads', (os, expected) => {
    expect(installCommand(ORIGIN, { ...TICKET, os } as typeof TICKET)).toBe(expected)
  })
})

describe('the Connectors page', () => {
  it('shows both ways to start the agent once a platform is picked', async () => {
    const face = mount()

    fireEvent.click(screen.getByText(en.platformLinux))

    await waitFor(() => { expect(document.querySelector('[data-connector-ticket]')).not.toBeNull() })
    expect(face.issue).toHaveBeenCalledWith('linux')
    expect(document.querySelector('[data-connector-command]')?.textContent)
      .toBe(`curl -fsSL '${ORIGIN}/connector/pack/enrol-1' | bash`)
    const download = document.querySelector('[data-connector-download]')
    expect(download?.getAttribute('href')).toBe(`${ORIGIN}/connector/pack/enrol-1`)
    expect(download?.getAttribute('download')).toBe('dsh-connector.sh')
    // The list is re-read as soon as an enrollment exists, so a machine that
    // dials in immediately is not hidden until the next poll.
    expect(face.list).toHaveBeenCalledTimes(2)
  })

  it('copies the command and says so, then goes quiet again', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    const face = mount()
    fireEvent.click(screen.getByText(en.platformWindows))
    await waitFor(() => { expect(document.querySelector('[data-connector-ticket]')).not.toBeNull() })

    fireEvent.click(screen.getByText(en.copyCommand))

    await waitFor(() => { expect(screen.queryByText(en.copied)).not.toBeNull() })
    expect(face.copy).toHaveBeenCalledWith(`curl -fsSL '${ORIGIN}/connector/pack/enrol-1' | bash`)
    await vi.advanceTimersByTimeAsync(2000)
    await waitFor(() => { expect(screen.queryByText(en.copyCommand)).not.toBeNull() })
    vi.useRealTimers()
  })

  it('stays usable when the clipboard refuses', async () => {
    mount({ copy: vi.fn<ConnectorsSectionInjected['copy']>().mockRejectedValue(new Error('denied')) })
    fireEvent.click(screen.getByText(en.platformLinux))
    await waitFor(() => { expect(document.querySelector('[data-connector-ticket]')).not.toBeNull() })

    fireEvent.click(screen.getByText(en.copyCommand))

    await waitFor(() => { expect(screen.queryByText(en.copied)).toBeNull() })
  })

  it('reports a platform whose enrollment could not be minted', async () => {
    mount({ issue: vi.fn<ConnectorsSectionInjected['issue']>().mockRejectedValue(new Error('down')) })

    fireEvent.click(screen.getByText(en.platformMacos))

    await waitFor(() => { expect(screen.queryByText(en.issueFailed)).not.toBeNull() })
    expect(document.querySelector('[data-connector-ticket]')).toBeNull()
  })

  it('reports an empty ledger, and a ledger it cannot read', async () => {
    mount()
    await waitFor(() => { expect(screen.queryByText(en.listEmpty)).not.toBeNull() })
    cleanup()

    mount({ list: vi.fn<ConnectorsSectionInjected['list']>().mockRejectedValue(new Error('down')) })

    await waitFor(() => { expect(screen.queryByText(en.listFailed)).not.toBeNull() })
  })

  it('names an attached machine, its connector id, and its working directory', async () => {
    mount({
      list: vi.fn<ConnectorsSectionInjected['list']>()
        .mockResolvedValue(snapshot([machine(), machine({ enrollmentId: id('enrol-2'), status: 'issued', label: null })])),
    })

    await waitFor(() => { expect(screen.queryByText('build-box')).not.toBeNull() })

    expect(document.querySelector('[data-connector-id]')?.textContent).toBe('enrol-1')
    expect(screen.queryByText('/srv/work')).not.toBeNull()
    expect(screen.queryByText(en.statusAttached)).not.toBeNull()
    // An enrollment nothing has dialled in for shows its platform instead of a
    // machine name, and no connector id a session could bind.
    expect(screen.queryByText(en.statusIssued)).not.toBeNull()
    expect(screen.queryAllByText('linux')).toHaveLength(1)
  })

  it('re-reads the ledger on demand and after a machine is removed', async () => {
    const face = mount({
      list: vi.fn<ConnectorsSectionInjected['list']>()
        .mockResolvedValueOnce(snapshot([machine()]))
        .mockResolvedValue(snapshot()),
    })
    await waitFor(() => { expect(screen.queryByText('build-box')).not.toBeNull() })

    fireEvent.click(screen.getByText(en.revoke))

    await waitFor(() => { expect(screen.queryByText(en.listEmpty)).not.toBeNull() })
    expect(face.revoke).toHaveBeenCalledWith('enrol-1')
    fireEvent.click(screen.getByText(en.refresh))
    await waitFor(() => { expect(face.list).toHaveBeenCalledTimes(3) })
  })

  it('re-reads the ledger after a removal the portal refused', async () => {
    const face = mount({
      list: vi.fn<ConnectorsSectionInjected['list']>().mockResolvedValue(snapshot([machine()])),
      revoke: vi.fn<ConnectorsSectionInjected['revoke']>().mockRejectedValue(new Error('gone')),
    })
    await waitFor(() => { expect(screen.queryByText('build-box')).not.toBeNull() })

    fireEvent.click(screen.getByText(en.revoke))

    await waitFor(() => { expect(face.list).toHaveBeenCalledTimes(2) })
    expect(screen.queryByText('build-box')).not.toBeNull()
  })

  it.each([
    ['fulfils', (task: ReturnType<typeof deferred<never>>) => { task.settle(undefined as never) }],
    ['rejects', (task: ReturnType<typeof deferred<never>>) => { task.fail(new Error('late')) }],
  ])('ignores a ledger read that %s after the page is closed', (_case, finish) => {
    const task = deferred<never>()
    const page = mount({ list: vi.fn<ConnectorsSectionInjected['list']>().mockReturnValue(task.promise) })

    page.view.unmount()

    expect(() => { finish(task) }).not.toThrow()
  })

  it.each([
    ['fulfils', (task: ReturnType<typeof deferred<never>>) => { task.settle(TICKET as never) }],
    ['rejects', (task: ReturnType<typeof deferred<never>>) => { task.fail(new Error('late')) }],
  ])('ignores an enrollment that %s after the page is closed', (_case, finish) => {
    const task = deferred<never>()
    const page = mount({ issue: vi.fn<ConnectorsSectionInjected['issue']>().mockReturnValue(task.promise) })
    fireEvent.click(screen.getByText(en.platformLinux))

    page.view.unmount()

    expect(() => { finish(task) }).not.toThrow()
  })

  it('ignores a clipboard write and its feedback timer after the page is closed', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    const task = deferred<undefined>()
    const page = mount({ copy: vi.fn<ConnectorsSectionInjected['copy']>().mockReturnValue(task.promise) })
    fireEvent.click(screen.getByText(en.platformLinux))
    await waitFor(() => { expect(document.querySelector('[data-connector-ticket]')).not.toBeNull() })
    fireEvent.click(screen.getByText(en.copyCommand))

    page.view.unmount()
    task.settle(undefined)

    // The write settles after the close, so no success ever shows and the
    // timer that would have cleared it has nothing to clear.
    await vi.advanceTimersByTimeAsync(4000)
    expect(screen.queryByText(en.copied)).toBeNull()
    vi.useRealTimers()
  })

  it('drops the copied feedback timer that outlives the page', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    const page = mount()
    fireEvent.click(screen.getByText(en.platformLinux))
    await waitFor(() => { expect(document.querySelector('[data-connector-ticket]')).not.toBeNull() })
    fireEvent.click(screen.getByText(en.copyCommand))
    await waitFor(() => { expect(screen.queryByText(en.copied)).not.toBeNull() })

    page.view.unmount()
    await vi.advanceTimersByTimeAsync(4000)

    expect(screen.queryByText(en.copied)).toBeNull()
    vi.useRealTimers()
  })

  it('polls the ledger while it is open and stops once it is closed', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    const face = mount()
    await waitFor(() => { expect(face.list).toHaveBeenCalledTimes(1) })

    await vi.advanceTimersByTimeAsync(4000)
    expect(face.list).toHaveBeenCalledTimes(2)

    cleanup()
    await vi.advanceTimersByTimeAsync(8000)
    expect(face.list).toHaveBeenCalledTimes(2)
    vi.useRealTimers()
  })
})

describe('the liveness check', () => {
  it('reports the round trip a live machine completed', async () => {
    const face = mount({ list: vi.fn<ConnectorsSectionInjected['list']>().mockResolvedValue(snapshot([machine()])) })
    await waitFor(() => { expect(screen.queryByText('build-box')).not.toBeNull() })

    fireEvent.click(screen.getByText(en.probe))

    await waitFor(() => {
      expect(document.querySelector('[data-connector-probe-result]')?.getAttribute('data-connector-probe-result'))
        .toBe('alive')
    })
    expect(face.probe).toHaveBeenCalledWith('enrol-1')
    expect(document.querySelector('[data-connector-probe-result]')?.textContent)
      .toBe('Link is alive: 12 ms round trip, and the target resolved its working directory /srv/work.')
  })

  it('says the working directory is gone when the target no longer has one', async () => {
    mount({
      list: vi.fn<ConnectorsSectionInjected['list']>().mockResolvedValue(snapshot([machine()])),
      probe: vi.fn<ConnectorsSectionInjected['probe']>().mockResolvedValue({
        alive: true, enrollmentId: id('enrol-1'), probedAt: 0, latencyMs: 7, resolvedWorkdir: '/srv/work', workdirIsDirectory: false,
      } as Report),
    })
    await waitFor(() => { expect(screen.queryByText('build-box')).not.toBeNull() })

    fireEvent.click(screen.getByText(en.probe))

    await waitFor(() => { expect(screen.queryByText(/is not a directory on the target/)).not.toBeNull() })
  })

  it('shows the deployment\u2019s own message when the link does not answer', async () => {
    mount({
      list: vi.fn<ConnectorsSectionInjected['list']>().mockResolvedValue(snapshot([machine()])),
      probe: vi.fn<ConnectorsSectionInjected['probe']>().mockResolvedValue({
        alive: false, enrollmentId: id('enrol-1'), probedAt: 0, failure: 'not-attached', message: 're-run the connector pack on the target',
      } as Report),
    })
    await waitFor(() => { expect(screen.queryByText('build-box')).not.toBeNull() })

    fireEvent.click(screen.getByText(en.probe))

    await waitFor(() => { expect(screen.queryByText('re-run the connector pack on the target')).not.toBeNull() })
    expect(document.querySelector('[data-connector-probe-result="dead"]')).not.toBeNull()
  })

  it('reports a check that never reached the deployment at all', async () => {
    mount({
      list: vi.fn<ConnectorsSectionInjected['list']>().mockResolvedValue(snapshot([machine()])),
      probe: vi.fn<ConnectorsSectionInjected['probe']>().mockRejectedValue(new Error('offline')),
    })
    await waitFor(() => { expect(screen.queryByText('build-box')).not.toBeNull() })

    fireEvent.click(screen.getByText(en.probe))

    await waitFor(() => { expect(screen.queryByText(en.probeFailed)).not.toBeNull() })
  })

  it('is offered only for a machine that has dialled in', async () => {
    mount({
      list: vi.fn<ConnectorsSectionInjected['list']>()
        .mockResolvedValue(snapshot([machine({ status: 'downloaded', label: null })])),
    })

    await waitFor(() => { expect(screen.queryByText(en.statusDownloaded)).not.toBeNull() })
    expect(document.querySelector('[data-connector-probe]')).toBeNull()
  })

  it.each([
    ['fulfils', (task: ReturnType<typeof deferred<never>>) => { task.settle(undefined as never) }],
    ['rejects', (task: ReturnType<typeof deferred<never>>) => { task.fail(new Error('late')) }],
  ])('ignores a check that %s after the page is closed', async (_case, finish) => {
    const task = deferred<never>()
    const page = mount({
      list: vi.fn<ConnectorsSectionInjected['list']>().mockResolvedValue(snapshot([machine()])),
      probe: vi.fn<ConnectorsSectionInjected['probe']>().mockReturnValue(task.promise),
    })
    await waitFor(() => { expect(screen.queryByText(en.probe)).not.toBeNull() })
    fireEvent.click(screen.getByText(en.probe))

    page.view.unmount()

    expect(() => { finish(task) }).not.toThrow()
  })
})

describe('starting a chat on a machine', () => {
  it('starts one on the composition the deployment reported, and clears the row', async () => {
    const startChat = vi.fn<NonNullable<ConnectorsSectionInjected['startChat']>>().mockResolvedValue(undefined)
    mount({ list: vi.fn<ConnectorsSectionInjected['list']>().mockResolvedValue(snapshot([machine()])), startChat })
    await waitFor(() => { expect(screen.queryByText(en.startChat)).not.toBeNull() })

    fireEvent.click(screen.getByText(en.startChat))

    await waitFor(() => { expect(startChat).toHaveBeenCalledTimes(1) })
    expect(startChat).toHaveBeenCalledWith(expect.objectContaining({ connectorId: 'enrol-1' }), 'connector')
    await waitFor(() => { expect(screen.queryByText(en.chatStarting)).toBeNull() })
  })

  it('reports a session the host refused to create', async () => {
    const startChat = vi.fn<NonNullable<ConnectorsSectionInjected['startChat']>>()
      .mockRejectedValue(new Error('connector-not-registered'))
    mount({ list: vi.fn<ConnectorsSectionInjected['list']>().mockResolvedValue(snapshot([machine()])), startChat })
    await waitFor(() => { expect(screen.queryByText(en.startChat)).not.toBeNull() })

    fireEvent.click(screen.getByText(en.startChat))

    await waitFor(() => { expect(screen.queryByText(/connector-not-registered/)).not.toBeNull() })
  })

  it('withholds the action and explains itself when the deployment cannot bind a session', async () => {
    mount({
      list: vi.fn<ConnectorsSectionInjected['list']>().mockResolvedValue(
        snapshot([machine()], { ready: false, reason: 'preset-missing', message: 'agent preset "connector" is not in this deployment\u2019s roster' }),
      ),
      startChat: vi.fn<NonNullable<ConnectorsSectionInjected['startChat']>>().mockResolvedValue(undefined),
    })

    await waitFor(() => { expect(screen.queryByText('build-box')).not.toBeNull() })
    expect(document.querySelector('[data-connector-start-chat]')).toBeNull()
    expect(document.querySelector('[data-connector-chat-unavailable]')?.getAttribute('data-connector-chat-unavailable'))
      .toBe('preset-missing')
  })

  it('hides the action entirely where no conversation flow is mounted', async () => {
    mount({ list: vi.fn<ConnectorsSectionInjected['list']>().mockResolvedValue(snapshot([machine()])) })

    await waitFor(() => { expect(screen.queryByText('build-box')).not.toBeNull() })
    expect(document.querySelector('[data-connector-start-chat]')).toBeNull()
    expect(document.querySelector('[data-connector-chat-unavailable]')).toBeNull()
  })

  it.each([
    ['fulfils', (task: ReturnType<typeof deferred<undefined>>) => { task.settle(undefined) }],
    ['rejects', (task: ReturnType<typeof deferred<undefined>>) => { task.fail(new Error('late')) }],
  ])('ignores a session that %s after the page is closed', async (_case, finish) => {
    const task = deferred<undefined>()
    const page = mount({
      list: vi.fn<ConnectorsSectionInjected['list']>().mockResolvedValue(snapshot([machine()])),
      startChat: vi.fn<NonNullable<ConnectorsSectionInjected['startChat']>>().mockReturnValue(task.promise),
    })
    await waitFor(() => { expect(screen.queryByText(en.startChat)).not.toBeNull() })
    fireEvent.click(screen.getByText(en.startChat))

    page.view.unmount()

    expect(() => { finish(task) }).not.toThrow()
  })
})
