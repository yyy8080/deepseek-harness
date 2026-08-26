/**
 * Session-id namespacing between the control plane and the instances behind
 * it. Every instance mints its own session ids from its own store, so two
 * instances can and eventually will mint the same one; the gateway therefore
 * shows callers a global id that carries the owning instance, and rewrites in
 * both directions at the edge. Instances never see a global id and the
 * control plane never routes on a local one.
 * @module @deepseek-ai/dsh-instance-gateway/routing
 */

import type { InstanceId } from '@deepseek-ai/dsh-instance'

/**
 * Separator between the instance id and the instance-local session id.
 * Unreserved in URLs and absent from every id the harness mints, so a global
 * id survives a query string and splits unambiguously at its first
 * occurrence. Wire-visible: a client that stores a session id stores this
 * form.
 */
export const INSTANCE_ID_SEPARATOR = '~'

/**
 * JSON property names whose string value is one session id. The set is the
 * complete list the `/api` contract declares across payloads, values, and
 * error details; rewriting by property name rather than by value pattern is
 * what keeps ids the gateway does not own — call ids, message ids, approval
 * ids — untouched.
 */
const SESSION_ID_KEYS: ReadonlySet<string> = new Set([
  'sessionId',
  'parentSessionId',
  'childSessionId',
  'beforeSessionId',
])

/** JSON property names whose value is an array of session ids. */
const SESSION_ID_LIST_KEYS: ReadonlySet<string> = new Set([
  'sessionIds',
  'archivedSessionIds',
])

/** One global session id split into its parts. */
export interface GlobalSessionId {
  /** The instance that owns the session. */
  instanceId: InstanceId
  /** The id as that instance's own store knows it. */
  localSessionId: string
}

/**
 * Compose the client-visible id of one instance-local session.
 * @param instanceId - the owning instance.
 * @param localSessionId - the id the instance minted.
 * @returns the global id clients address the session by.
 */
export function globalSessionId(instanceId: InstanceId, localSessionId: string): string {
  return `${instanceId}${INSTANCE_ID_SEPARATOR}${localSessionId}`
}

/**
 * Split a client-supplied session id into instance and local parts.
 * @param value - the id as the client sent it.
 * @returns the parts, or `undefined` when the id carries no instance prefix
 * (a session of the control plane's own store).
 */
export function splitGlobalSessionId(value: string): GlobalSessionId | undefined {
  const at = value.indexOf(INSTANCE_ID_SEPARATOR)
  if (at <= 0 || at === value.length - 1) return undefined
  return {
    instanceId: value.slice(0, at) as InstanceId,
    localSessionId: value.slice(at + 1),
  }
}

/** Rewrite every session-id-valued string in one JSON tree through `map`. */
function rewrite(value: unknown, map: (id: string) => string, inList: boolean): unknown {
  if (typeof value === 'string') return inList ? map(value) : value
  if (Array.isArray(value)) return value.map(item => rewrite(item, map, inList))
  if (typeof value !== 'object' || value === null) return value
  const out: Record<string, unknown> = {}
  for (const [key, member] of Object.entries(value as Record<string, unknown>)) {
    if (typeof member === 'string' && SESSION_ID_KEYS.has(key)) {
      out[key] = map(member)
    } else if (SESSION_ID_LIST_KEYS.has(key)) {
      out[key] = rewrite(member, map, true)
    } else {
      out[key] = rewrite(member, map, false)
    }
  }
  return out
}

/**
 * Rewrite an outbound value's session ids from instance-local to global.
 * @param value - anything the instance answered with.
 * @param instanceId - the instance that answered.
 * @returns a copy whose session ids name the instance.
 */
export function globalize<T>(value: T, instanceId: InstanceId): T {
  return rewrite(value, id => globalSessionId(instanceId, id), false) as T
}

/**
 * Rewrite an inbound payload's session ids from global to instance-local.
 *
 * A session id addressed to a different instance is a routing failure, not a
 * value to pass through: the receiving instance would answer `session-not-found`
 * for an id that does exist, one place over. Failing here names both instances.
 * @param value - the payload as the client sent it.
 * @param instanceId - the instance the request is routed to.
 * @returns a copy carrying only instance-local session ids.
 */
export function localize<T>(value: T, instanceId: InstanceId): T {
  return rewrite(value, (id) => {
    const split = splitGlobalSessionId(id)
    if (split === undefined) {
      throw new Error(`session ${JSON.stringify(id)} carries no instance prefix; it cannot be routed to ${instanceId}`)
    }
    if (split.instanceId !== instanceId) {
      throw new Error(`session ${JSON.stringify(id)} belongs to instance ${split.instanceId}, not ${instanceId}`)
    }
    return split.localSessionId
  }, false) as T
}
