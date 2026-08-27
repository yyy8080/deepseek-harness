/** The Connectors page registered into Web Settings. */

import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
// Type-only: pulls the shell's SlotMap merge (the 'settings.section' entry).
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
// Type-only: pulls the locale plugin's Context merge (ctx.locale).
import type {} from '@deepseek-ai/dsh-client-locale/client'
// Type-only: pulls the ctx.remote merge carrying the connectorPortal namespace.
import type {} from '@deepseek-ai/dsh-api-remotes/client'
import { ConnectorsSection } from './ConnectorsSection.tsx'
import type { ConnectorsSectionInjected } from './ConnectorsSection.tsx'
import { en, zh, type ConnectorsLocaleKey } from './locales.ts'

export type { ConnectorsSectionInjected, ConnectorsSectionProps } from './ConnectorsSection.tsx'
export { installCommand, probeSummary } from './ConnectorsSection.tsx'
export type { ConnectorsLocaleKey } from './locales.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** Connector download and pairing copy. */
    'settings.connectors': ConnectorsLocaleKey
  }
}

/** Dictionary namespace owned by this plugin. */
export const NS = 'settings.connectors'

/** Services required by the Settings registration and generated Remote face. */
export const inject = ['slots', 'locale', 'remote', 'remote.connectorPortal']

/**
 * Contribute the Connectors page to Settings.
 * @param ctx - client root context.
 */
export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'ui-settings-connectors: dictionaries')

  // Starting a conversation needs the sessions domain, which the Settings
  // surface itself does not require. Binding it in a nested scope keeps the
  // page mountable without a conversation flow and simply hides the action
  // there — the same arrangement the agent-preset section uses for its own
  // session-creating entry.
  let startChat: ConnectorsSectionInjected['startChat']
  ctx.inject(['sessions'], (scope: ClientContext) => {
    scope.effect(() => {
      startChat = async (enrollment, agentPreset) => {
        // The working directory is the TARGET's, not this machine's: it is
        // where the connector agent serves, and every relative path the
        // conversation resolves is resolved there.
        await scope.sessions.startConnectorSession({
          connectorId: enrollment.connectorId,
          agentPreset,
          cwd: enrollment.workdir ?? '',
        })
      }
      return () => { startChat = undefined }
    }, 'ui-settings-connectors: connector chat entry')
  })

  const t = ctx.locale.bind(NS) as ConnectorsSectionInjected['t']
  const issue: ConnectorsSectionInjected['issue'] = async (os) => {
    const result = await ctx.remote.connectorPortal.issue({ os })
    if (!result.ok) throw new Error(`connectorPortal.issue failed: ${result.error.code}: ${result.error.message}`)
    return result.value
  }
  const list: ConnectorsSectionInjected['list'] = async () => {
    const result = await ctx.remote.connectorPortal.list()
    if (!result.ok) throw new Error(`connectorPortal.list failed: ${result.error.code}: ${result.error.message}`)
    return result.value
  }
  const revoke: ConnectorsSectionInjected['revoke'] = async (enrollmentId) => {
    const result = await ctx.remote.connectorPortal.revoke({ enrollmentId })
    if (!result.ok) throw new Error(`connectorPortal.revoke failed: ${result.error.code}: ${result.error.message}`)
  }
  const probe: ConnectorsSectionInjected['probe'] = async (enrollmentId) => {
    const result = await ctx.remote.connectorPortal.probe({ enrollmentId })
    if (!result.ok) throw new Error(`connectorPortal.probe failed: ${result.error.code}: ${result.error.message}`)
    return result.value
  }
  // The pack URLs are same-origin paths: the browser's own address is the only
  // place the deployment's public origin is known for certain.
  const injected = (): ConnectorsSectionInjected => ({
    issue,
    list,
    revoke,
    probe,
    ...startChat === undefined ? {} : { startChat },
    origin: globalThis.location.origin,
    copy: async text => navigator.clipboard.writeText(text),
    t,
  })

  ctx.slots.inject('settings.section', () => ctx.slots.register({
    name: 'settings.section',
    id: 'connectors',
    order: 45,
    label: () => t('nav'),
    locale: NS,
    inject: injected,
  }, ConnectorsSection))
}
