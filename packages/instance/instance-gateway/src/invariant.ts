/**
 * Package-owned invariant companion for `@deepseek-ai/dsh-instance-gateway`:
 * the addressing relation between registry-minted instance ids and the global
 * session ids this package routes on.
 * @module @deepseek-ai/dsh-instance-gateway/invariant
 */

import type { Context } from '@deepseek-ai/cordis'
import type { InvariantFailure, InvariantInstaller } from '@deepseek-ai/dsh-invariants'
import type { InstanceView } from '@deepseek-ai/dsh-instance'
import { INSTANCE_ID_SEPARATOR } from './routing.ts'

const PACKAGE_NAME = '@deepseek-ai/dsh-instance-gateway'

/** Cordis companion plugin name. */
export const name = 'instance-gateway-invariant'
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

/**
 * Check one instance against the addressing this package's global session ids
 * depend on. A global id splits at the first separator, so an instance id
 * carrying one would route every session under it to a different instance —
 * silently, and only for that instance.
 * @param view - the announced instance state.
 * @param fail - invariant failure reporter.
 */
function validateAddressable(view: InstanceView, fail: InvariantFailure): void {
  if (view.id.includes(INSTANCE_ID_SEPARATOR)) {
    fail(`instance id ${JSON.stringify(view.id)} contains ${JSON.stringify(INSTANCE_ID_SEPARATOR)}, which global session ids split on`)
  }
  if (view.endpoint !== undefined && !URL.canParse(view.endpoint.origin)) {
    fail(`instance ${view.id} published unroutable origin ${JSON.stringify(view.endpoint.origin)}`)
  }
}

/** Install validation over the registry's authoritative instance stream. */
const install: InvariantInstaller = Object.assign((ctx: Context, fail: InvariantFailure) => {
  for (const view of ctx.instances.list()) validateAddressable(view, fail)
  ctx.on('instance/changed', (view) => { validateAddressable(view, fail) }, { global: true })
}, { inject: ['instances'] })

/**
 * Register this package's invariant companion.
 * @param ctx - Cordis context carrying the invariant service.
 * @returns the installed registration's disposer after setup succeeds.
 */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
