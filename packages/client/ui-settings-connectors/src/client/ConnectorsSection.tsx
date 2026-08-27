/**
 * Connectors settings page: the one place a user turns another machine into an
 * execution target for this deployment.
 *
 * Picking a platform mints an enrollment and renders the two equivalent ways to
 * start its agent — a copyable one-line command and the same script as a file —
 * followed by the ledger of machines that have dialled in. The page polls that
 * ledger while it is open so a machine the user just started appears without
 * them reloading anything.
 *
 * Each connected machine carries the two actions that make it usable: a
 * liveness check that completes a round trip on its live link, and a button
 * that starts a conversation whose files and commands run there.
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import type {
  ConnectorChatAvailability,
  ConnectorEnrollmentStatus,
  ConnectorEnrollmentView,
  ConnectorPackOs,
  ConnectorPackTicket,
  ConnectorPortalSnapshot,
  ConnectorProbeReport,
} from '@deepseek-ai/dsh-api-remotes/client'
import type { InjectFace, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { ConnectorsLocaleKey } from './locales.ts'
import css from './ConnectorsSection.module.css'

/** How often the open page re-reads the enrollment ledger. */
const POLL_INTERVAL_MS = 4000

/** How long the copy button keeps reporting success. */
const COPIED_FEEDBACK_MS = 2000

/** One enrollment id, as the ledger rows carry it. */
type EnrollmentId = ConnectorEnrollmentView['enrollmentId']

/** Injected dependencies of {@link ConnectorsSection} (slot `inject`). */
export interface ConnectorsSectionInjected {
  /** Mint one enrollment and describe its pack. */
  issue: (os: ConnectorPackOs) => Promise<ConnectorPackTicket>
  /** Read the current enrollment ledger. */
  list: () => Promise<ConnectorPortalSnapshot>
  /** Discard one enrollment, disconnecting its agent when one is attached. */
  revoke: (enrollmentId: EnrollmentId) => Promise<void>
  /** Complete one round trip on a machine's live link and report the outcome. */
  probe: (enrollmentId: EnrollmentId) => Promise<ConnectorProbeReport>
  /**
   * Start a conversation bound to one machine and navigate into it. Absent
   * while no conversation flow is mounted, which is what hides the action.
   */
  startChat?: (enrollment: ConnectorEnrollmentView, agentPreset: string) => Promise<void>
  /** Absolute origin the browser reached this deployment on. */
  origin: string
  /** Copy text to the user's clipboard. */
  copy: (text: string) => Promise<void>
  /** Page copy. */
  t: (key: ConnectorsLocaleKey, params?: Record<string, unknown>) => string
}

/** Props delivered by the settings slot outlet. */
export type ConnectorsSectionProps =
  PropsRuntime<'settings.section'>
  & Partial<InjectFace<ConnectorsSectionInjected>>

type LedgerState =
  | { readonly status: 'loading' }
  | { readonly status: 'error' }
  | {
    readonly status: 'ready'
    readonly enrollments: readonly ConnectorEnrollmentView[]
    readonly chat: ConnectorChatAvailability
  }

/** What one machine row shows about its own liveness check right now. */
type ProbeState =
  | { readonly phase: 'running' }
  | { readonly phase: 'done'; readonly report: ConnectorProbeReport }
  | { readonly phase: 'unreachable' }

/** What one machine row shows about a conversation it is starting. */
type ChatState =
  | { readonly phase: 'starting' }
  | { readonly phase: 'failed'; readonly message: string }

/** The platforms the page offers, in the order they are shown. */
const PLATFORMS: ReadonlyArray<{ os: ConnectorPackOs; label: ConnectorsLocaleKey }> = [
  { os: 'linux', label: 'platformLinux' },
  { os: 'windows', label: 'platformWindows' },
  { os: 'macos', label: 'platformMacos' },
]

const STATUS_KEYS = {
  issued: 'statusIssued',
  downloaded: 'statusDownloaded',
  attached: 'statusAttached',
  expired: 'statusExpired',
} satisfies Record<ConnectorEnrollmentStatus, ConnectorsLocaleKey>

/**
 * The single command that installs and starts the agent. It fetches the very
 * script the download button saves, so both routes run identical code.
 * @param origin - the deployment origin the browser is on.
 * @param ticket - the freshly issued pack.
 * @returns the copyable one-line command.
 */
export function installCommand(origin: string, ticket: ConnectorPackTicket): string {
  const url = `${origin}${ticket.installPath}`
  return ticket.os === 'windows'
    ? `irm '${url}' | iex`
    : `curl -fsSL '${url}' | bash`
}

/**
 * One completed probe as a single line of copy: an alive machine reports its
 * latency and the directory the target itself resolved, a failed one reports
 * the deployment's own actionable message.
 * @param report - the probe outcome.
 * @param t - page copy.
 * @returns the line shown under the machine row.
 */
export function probeSummary(
  report: ConnectorProbeReport,
  t: ConnectorsSectionInjected['t'],
): string {
  if (!report.alive) return report.message
  return report.workdirIsDirectory
    ? t('probeAlive', { latency: report.latencyMs, workdir: report.resolvedWorkdir })
    : t('probeAliveNoWorkdir', { latency: report.latencyMs, workdir: report.resolvedWorkdir })
}

/** Render the Connectors page. */
export function ConnectorsSection(props: ConnectorsSectionProps): ReactNode {
  const { issue, list, revoke, probe, startChat, origin, copy, t } = props as ConnectorsSectionInjected
  const [ticket, setTicket] = useState<ConnectorPackTicket | null>(null)
  const [pending, setPending] = useState<ConnectorPackOs | null>(null)
  const [issueFailed, setIssueFailed] = useState(false)
  const [copied, setCopied] = useState(false)
  const [ledger, setLedger] = useState<LedgerState>({ status: 'loading' })
  const [probes, setProbes] = useState<ReadonlyMap<string, ProbeState>>(new Map())
  const [chats, setChats] = useState<ReadonlyMap<string, ChatState>>(new Map())
  const mounted = useRef(true)

  useEffect(() => () => { mounted.current = false }, [])

  const reload = useCallback(async (): Promise<void> => {
    try {
      const snapshot = await list()
      if (mounted.current) {
        setLedger({ status: 'ready', enrollments: snapshot.enrollments, chat: snapshot.chat })
      }
    } catch {
      if (mounted.current) setLedger({ status: 'error' })
    }
  }, [list])

  useEffect(() => {
    void reload()
    const timer = setInterval(() => { void reload() }, POLL_INTERVAL_MS)
    return () => { clearInterval(timer) }
  }, [reload])

  const onIssue = (os: ConnectorPackOs): void => {
    setPending(os)
    setIssueFailed(false)
    setCopied(false)
    void issue(os).then(
      (issued) => {
        if (!mounted.current) return
        setTicket(issued)
        setPending(null)
        void reload()
      },
      () => {
        if (!mounted.current) return
        setIssueFailed(true)
        setPending(null)
      },
    )
  }

  const onCopy = (command: string): void => {
    void copy(command).then(() => {
      if (!mounted.current) return
      setCopied(true)
      setTimeout(() => { if (mounted.current) setCopied(false) }, COPIED_FEEDBACK_MS)
    }, () => {})
  }

  const onRevoke = (enrollmentId: EnrollmentId): void => {
    void revoke(enrollmentId).then(() => reload(), () => reload())
  }

  const setRowState = <T,>(
    apply: (updater: (previous: ReadonlyMap<string, T>) => ReadonlyMap<string, T>) => void,
    key: string,
    value: T | undefined,
  ): void => {
    apply((previous) => {
      const next = new Map(previous)
      if (value === undefined) next.delete(key)
      else next.set(key, value)
      return next
    })
  }

  const onProbe = (enrollmentId: EnrollmentId): void => {
    const key = String(enrollmentId)
    setRowState(setProbes, key, { phase: 'running' })
    void probe(enrollmentId).then(
      (report) => {
        if (!mounted.current) return
        setRowState(setProbes, key, { phase: 'done', report })
        // A probe is also the freshest reading of the ledger's own status: a
        // machine that stopped answering is no longer the "Connected" the row
        // above it claims.
        void reload()
      },
      () => {
        if (!mounted.current) return
        setRowState(setProbes, key, { phase: 'unreachable' })
      },
    )
  }

  const onStartChat = (enrollment: ConnectorEnrollmentView, agentPreset: string): void => {
    if (startChat === undefined) return
    const key = String(enrollment.enrollmentId)
    setRowState(setChats, key, { phase: 'starting' })
    void startChat(enrollment, agentPreset).then(
      () => {
        // The conversation is already open behind this panel, so Settings has
        // to get out of the way for the user to reach it. Clearing the row
        // first keeps a reopened Settings from showing a stale "starting".
        if (mounted.current) setRowState(setChats, key, undefined)
        props.close()
      },
      (error: unknown) => {
        if (mounted.current) setRowState(setChats, key, { phase: 'failed', message: String(error) })
      },
    )
  }

  const command = ticket === null ? '' : installCommand(origin, ticket)

  return (
    <div className={css.section} data-settings-section="connectors">
      <p className={css.intro}>{t('intro')}</p>
      <p className={css.warning} role="note">{t('warning')}</p>

      <div className={css.platforms}>
        {PLATFORMS.map(platform => (
          <button
            key={platform.os}
            type="button"
            className={css.platform}
            data-connector-platform={platform.os}
            disabled={pending !== null}
            onClick={() => { onIssue(platform.os) }}
          >
            <strong>{t(platform.label)}</strong>
            <span>{pending === platform.os ? t('downloading') : t('download')}</span>
          </button>
        ))}
      </div>
      {issueFailed ? <p className={css.failure} role="alert">{t('issueFailed')}</p> : null}

      {ticket !== null ? (
        <div className={css.ticket} data-connector-ticket={ticket.os}>
          <h3>{t('ticketHeading')}</h3>
          <div className={css.command}>
            <code data-connector-command>{command}</code>
            <button type="button" onClick={() => { onCopy(command) }}>
              {copied ? t('copied') : t('copyCommand')}
            </button>
          </div>
          <p className={css.hint}>
            <a href={`${origin}${ticket.downloadPath}`} download={ticket.fileName} data-connector-download>
              {t('downloadFile')}
            </a>
            {' · '}
            {t('needsNode')}
          </p>
          <p className={css.hint}>
            {t('ticketHint', { expires: new Date(ticket.expiresAt).toLocaleTimeString() })}
          </p>
        </div>
      ) : null}

      <div className={css.ledgerHeading}>
        <h3>{t('listHeading')}</h3>
        <button type="button" onClick={() => { void reload() }}>{t('refresh')}</button>
      </div>
      {ledger.status === 'error' ? (
        <p className={css.failure} role="alert">{t('listFailed')}</p>
      ) : null}
      {ledger.status === 'ready' && ledger.enrollments.length === 0 ? (
        <p className={css.hint}>{t('listEmpty')}</p>
      ) : null}
      {ledger.status === 'ready' && ledger.enrollments.length > 0 ? (
        <ul className={css.machines}>
          {ledger.enrollments.map((enrollment) => {
            const key = String(enrollment.enrollmentId)
            const probeState = probes.get(key)
            const chatState = chats.get(key)
            const attached = enrollment.status === 'attached'
            const chat = ledger.chat
            return (
              <li key={key} className={css.machine} data-connector-status={enrollment.status}>
                <div className={css.machineHead}>
                  <strong>{enrollment.label ?? enrollment.os}</strong>
                  <span className={css.status} data-status={enrollment.status}>
                    {t(STATUS_KEYS[enrollment.status])}
                  </span>
                  {attached ? (
                    <button
                      type="button"
                      data-connector-probe
                      disabled={probeState?.phase === 'running'}
                      onClick={() => { onProbe(enrollment.enrollmentId) }}
                    >
                      {probeState?.phase === 'running' ? t('probing') : t('probe')}
                    </button>
                  ) : null}
                  {attached && startChat !== undefined && chat.ready ? (
                    <button
                      type="button"
                      data-connector-start-chat
                      disabled={chatState?.phase === 'starting'}
                      onClick={() => { onStartChat(enrollment, chat.agentPreset) }}
                    >
                      {chatState?.phase === 'starting' ? t('chatStarting') : t('startChat')}
                    </button>
                  ) : null}
                  <button type="button" onClick={() => { onRevoke(enrollment.enrollmentId) }}>
                    {t('revoke')}
                  </button>
                </div>
                {attached ? (
                  <dl className={css.details}>
                    <div>
                      <dt>{t('connectorIdLabel')}</dt>
                      <dd><code data-connector-id>{enrollment.connectorId}</code></dd>
                    </div>
                    <div>
                      <dt>{t('workdirLabel')}</dt>
                      <dd>{enrollment.workdir}</dd>
                    </div>
                  </dl>
                ) : null}
                {probeState?.phase === 'done' ? (
                  <p
                    className={probeState.report.alive ? css.hint : css.failure}
                    data-connector-probe-result={probeState.report.alive ? 'alive' : 'dead'}
                    role={probeState.report.alive ? undefined : 'alert'}
                  >
                    {probeSummary(probeState.report, t)}
                  </p>
                ) : null}
                {probeState?.phase === 'unreachable' ? (
                  <p className={css.failure} data-connector-probe-result="dead" role="alert">
                    {t('probeFailed')}
                  </p>
                ) : null}
                {chatState?.phase === 'failed' ? (
                  <p className={css.failure} role="alert">
                    {t('chatFailed', { reason: chatState.message })}
                  </p>
                ) : null}
                {attached && startChat !== undefined && !chat.ready ? (
                  <p className={css.hint} data-connector-chat-unavailable={chat.reason}>
                    {t('chatUnavailable', { reason: chat.message })}
                  </p>
                ) : null}
              </li>
            )
          })}
        </ul>
      ) : null}
      <p className={css.hint}>{t('bindHint')}</p>
    </div>
  )
}
