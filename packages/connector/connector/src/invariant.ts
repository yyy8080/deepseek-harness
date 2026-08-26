/**
 * Package-owned invariant companion for `@deepseek-ai/dsh-connector`: the
 * announced-link relation between the `connector/link-opened` stream and the
 * registry that authorized the link.
 * @module @deepseek-ai/dsh-connector/invariant
 */

import type { Context } from '@deepseek-ai/cordis'
import type { InvariantFailure, InvariantInstaller } from '@deepseek-ai/dsh-invariants'
import type { ConnectorDescriptor } from './types.ts'

const PACKAGE_NAME = '@deepseek-ai/dsh-connector'

/** Cordis companion plugin name. */
export const name = 'connector-invariant'
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

/**
 * Check one announced link against the registration it claims to serve. A live
 * link for an unregistered connector, or one whose OS family disagrees with the
 * registration, would route a session's files and commands to a machine the
 * deployment never declared.
 * @param ctx - context carrying the connector registry.
 * @param descriptor - the announced connector.
 * @param fail - invariant failure reporter.
 */
function validateAnnouncement(ctx: Context, descriptor: ConnectorDescriptor, fail: InvariantFailure): void {
  const registered = ctx.connectors.get(descriptor.id)
  if (registered === undefined) {
    fail(`connector ${String(descriptor.id)} opened a link while unregistered`)
    return
  }
  if (registered.os !== descriptor.os) {
    fail(`connector ${String(descriptor.id)} opened a ${descriptor.os} link while registered as ${registered.os}`)
  }
}

/** Install validation for the announced connector-link stream. */
const install: InvariantInstaller = Object.assign((ctx: Context, fail: InvariantFailure) => {
  ctx.on('connector/link-opened', (descriptor) => { validateAnnouncement(ctx, descriptor, fail) }, { global: true })
}, { inject: ['connectors'] })

/**
 * Register this package's invariant companion.
 * @param ctx - Cordis context carrying the invariant service.
 * @returns the installed registration's disposer after setup succeeds.
 */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
