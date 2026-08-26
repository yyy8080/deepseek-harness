/**
 * Package-owned invariant companion for `@deepseek-ai/dsh-connector-tcp`.
 * @module @deepseek-ai/dsh-connector-tcp/invariant
 */

/* jscpd:ignore-start */
import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@deepseek-ai/dsh-connector-tcp'

/** Cordis companion plugin name. */
export const name = 'connector-tcp-invariant'
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

/**
 * No runtime invariant: the declared-versus-reported agreement this transport
 * enforces is a handshake precondition rather than a relation over a live event
 * stream, and the announced-link relation belongs to the connector registry's
 * own companion.
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
