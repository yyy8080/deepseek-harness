/**
 * Package-owned invariant companion for `@deepseek-ai/dsh-host-connector-portal`:
 * the announced-attachment relation between the `connector-portal/attached`
 * stream and the connector registry a session binds through.
 * @module @deepseek-ai/dsh-host-connector-portal/invariant
 */

import type { Context } from '@deepseek-ai/cordis'
import type { InvariantFailure, InvariantInstaller } from '@deepseek-ai/dsh-invariants'
import type {} from '@deepseek-ai/dsh-connector'
import type {} from './index.ts'

const PACKAGE_NAME = '@deepseek-ai/dsh-host-connector-portal'

/** Cordis companion plugin name. */
export const name = 'host-connector-portal-invariant'
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

/**
 * Check one announced attachment against the registry. The portal registers the
 * machine before announcing it, so the registry must answer for that id by the
 * time the announcement is observable; announcing one it never registered would
 * show the operator an online target no conversation can bind.
 */
const install: InvariantInstaller = Object.assign((ctx: Context, fail: InvariantFailure) => {
  ctx.on('connector-portal/attached', (enrollmentId) => {
    const registered = ctx.connectors.list().some(descriptor => String(descriptor.id) === String(enrollmentId))
    if (!registered) {
      fail(`enrollment ${JSON.stringify(String(enrollmentId))} attached without a matching connector registration`)
    }
  }, { global: true })
}, { inject: ['connectors'] })

/**
 * Register this package's invariant companion.
 * @param ctx - Cordis context carrying the invariant service.
 * @returns the installed registration's disposer after setup succeeds.
 */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
