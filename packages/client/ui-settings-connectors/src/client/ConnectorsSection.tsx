/**
 * Connectors settings page: the one place a user turns another machine into an
 * execution target for this deployment.
 *
 * Picking a platform mints an enrollment and renders the two equivalent ways to
 * start its agent — a copyable one-line command and the same script as a file —
 * followed by the ledger of machines that have dialled in. The page polls that
 * ledger while it is open so a machine the user just started appears without
 * them reloading anything.
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import type {
  ConnectorEnrollmentStatus,
  ConnectorEnrollmentView,
  ConnectorPackOs,
  ConnectorPackTicket,
  ConnectorPortalSnapshot,
} from '@deepseek-ai/dsh-api-remotes/client'
import type { InjectFace } from '@deepseek-ai/dsh-client-ui-slots'
import type { ConnectorsLocaleKey } from './locales.ts'
import css from './ConnectorsSection.module.css'

/** How often the open page re-reads the enrollment ledger. */
const POLL_INTERVAL_MS = 4000

/** How long the copy button keeps reporting success. */
const COPIED_FEEDBACK_MS = 2000

/** Injected dependencies of {@link ConnectorsSection} (slot `inject`). */
export interface ConnectorsSectionInjected {
  /** Mint one enrollment and describe its pack. */
  issue: (os: ConnectorPackOs) => Promise<ConnectorPackTicket>
  /** Read the current enrollment ledger. */
  list: () => Promise<ConnectorPortalSnapshot>
  /** Discard one enrollment, disconnecting its agent when one is attached. */
  revoke: (enrollmentId: ConnectorEnrollmentView['enrollmentId']) => Promise<void>
  /** Absolute origin the browser reached this deployment on. */
  origin: string
  /** Copy text to the user's clipboard. */
  copy: (text: string) => Promise<void>
  /** Page copy. */
  t: (key: ConnectorsLocaleKey, params?: Record<string, unknown>) => string
}

/** Props delivered by the settings slot outlet. */
export type ConnectorsSectionProps = Partial<InjectFace<ConnectorsSectionInjected>>

type LedgerState =
  | { readonly status: 'loading' }
  | { readonly status: 'error' }
  | { readonly status: 'ready'; readonly enrollments: readonly ConnectorEnrollmentView[] }

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

/** Render the Connectors page. */
export function ConnectorsSection(props: ConnectorsSectionProps): ReactNode {
  const { issue, list, revoke, origin, copy, t } = props as ConnectorsSectionInjected
  const [ticket, setTicket] = useState<ConnectorPackTicket | null>(null)
  const [pending, setPending] = useState<ConnectorPackOs | null>(null)
  const [issueFailed, setIssueFailed] = useState(false)
  const [copied, setCopied] = useState(false)
  const [ledger, setLedger] = useState<LedgerState>({ status: 'loading' })
  const mounted = useRef(true)

  useEffect(() => () => { mounted.current = false }, [])

  const reload = useCallback(async (): Promise<void> => {
    try {
      const snapshot = await list()
      if (mounted.current) setLedger({ status: 'ready', enrollments: snapshot.enrollments })
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

  const onRevoke = (enrollmentId: ConnectorEnrollmentView['enrollmentId']): void => {
    void revoke(enrollmentId).then(() => reload(), () => reload())
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
          {ledger.enrollments.map(enrollment => (
            <li
              key={String(enrollment.enrollmentId)}
              className={css.machine}
              data-connector-status={enrollment.status}
            >
              <div className={css.machineHead}>
                <strong>{enrollment.label ?? enrollment.os}</strong>
                <span className={css.status} data-status={enrollment.status}>
                  {t(STATUS_KEYS[enrollment.status])}
                </span>
                <button type="button" onClick={() => { onRevoke(enrollment.enrollmentId) }}>
                  {t('revoke')}
                </button>
              </div>
              {enrollment.status === 'attached' ? (
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
            </li>
          ))}
        </ul>
      ) : null}
      <p className={css.hint}>{t('bindHint')}</p>
    </div>
  )
}
