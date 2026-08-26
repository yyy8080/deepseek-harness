/**
 * Package-owned invariant companion for `@deepseek-ai/dsh-instance`: the
 * published-state relation between the `instance/changed` stream and the
 * registry snapshot.
 * @module @deepseek-ai/dsh-instance/invariant
 */

import type { Context } from '@deepseek-ai/cordis'
import type { InvariantFailure, InvariantInstaller } from '@deepseek-ai/dsh-invariants'
import type { InstanceView } from './types.ts'

const PACKAGE_NAME = '@deepseek-ai/dsh-instance'

/** Cordis companion plugin name. */
export const name = 'instance-invariant'
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

/**
 * Check one announced view against the endpoint contract and the registry it
 * claims to describe.
 * @param ctx - context carrying the instance registry.
 * @param view - the announced instance state.
 * @param fail - invariant failure reporter.
 */
function validateAnnouncement(ctx: Context, view: InstanceView, fail: InvariantFailure): void {
  if ((view.endpoint !== undefined) !== (view.lifecycle === 'running')) {
    fail(`instance ${view.id} announced lifecycle ${view.lifecycle} with${view.endpoint === undefined ? 'out' : ''} an endpoint`)
  }
  if ((view.failure !== undefined) && view.lifecycle !== 'failed') {
    fail(`instance ${view.id} announced lifecycle ${view.lifecycle} carrying a failure`)
  }
  const current = ctx.instances.get(view.id)
  // A removal announcement is the one case with no registry row left; every
  // other announcement is published after the transition is committed, so the
  // snapshot must already agree with it.
  if (current !== undefined && current.lifecycle !== view.lifecycle) {
    fail(`instance ${view.id} announced ${view.lifecycle} while the registry holds ${current.lifecycle}`)
  }
}

/** Install validation for the announced instance-state stream. */
const install: InvariantInstaller = Object.assign((ctx: Context, fail: InvariantFailure) => {
  for (const view of ctx.instances.list()) validateAnnouncement(ctx, view, fail)
  ctx.on('instance/changed', (view) => { validateAnnouncement(ctx, view, fail) }, { global: true })
}, { inject: ['instances'] })

/**
 * Register this package's invariant companion.
 * @param ctx - Cordis context carrying the invariant service.
 * @returns the installed registration's disposer after setup succeeds.
 */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
