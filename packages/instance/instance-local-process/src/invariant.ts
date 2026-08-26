/**
 * Package-owned invariant companion for `@deepseek-ai/dsh-instance-local-process`.
 * @module @deepseek-ai/dsh-instance-local-process/invariant
 */

/* jscpd:ignore-start */
import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@deepseek-ai/dsh-instance-local-process'

/** Cordis companion plugin name. */
export const name = 'instance-local-process-invariant'
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

/**
 * No runtime invariant: this package contributes one provider registration and
 * owns no event stream or mutable data of its own — the lifecycle relation
 * between an announced instance and its endpoint is asserted by the registry's
 * own companion in `@deepseek-ai/dsh-instance`.
 */
const install: InvariantInstaller = () => {}

/**
 * Register this package's invariant companion.
 * @param ctx - Cordis context carrying the invariant service.
 * @returns the installed registration's disposer after setup succeeds.
 */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
/* jscpd:ignore-end */
