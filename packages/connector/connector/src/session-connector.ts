/**
 * Per-session connector binding: the session log as the store. Binding a
 * conversation to a connector is one `connector/bound` event on that session;
 * `effective = fold(events) ?? the deployment default`, so the binding survives
 * restart by replay and two sessions never see each other's target machine.
 *
 * The binding lives here rather than in a filesystem or subprocess provider
 * because both must agree on one execution world: they resolve the same fold
 * at every operation boundary.
 *
 * @module @deepseek-ai/dsh-connector/session-connector
 */

import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import { ConnectorId } from './types.ts'

declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap {
    /**
     * The session's execution world was bound to a connector — log-only (like
     * `sandbox/mode`; NOT a surface event, carries no `surfaceOp`): durable and
     * replayable, never in the model transcript. The LAST such event is the
     * session's binding ({@link effectiveConnectorId}).
     */
    'connector/bound': {
      /** The connector every file and process operation in this session reaches. */
      connectorId: ConnectorId
    }
  }
}

/**
 * The session's connector binding: the last `connector/bound` event in the log,
 * or undefined when the session never bound one (callers apply the deployment
 * default). The pure fold — replaying the log IS the state.
 * @param events - session events in log order (other event types are skipped).
 * @returns the connector id of the last binding event, or undefined without one.
 */
export function effectiveConnectorId(events: readonly SessionEvent[]): ConnectorId | undefined {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index] as SessionEvent
    if (event.type === 'connector/bound') return event.data.connectorId
  }
  return undefined
}

/**
 * THE write path for a session's connector binding: appends exactly one
 * `connector/bound` event. Takes effect on the session's next file or process
 * operation, because the connector-backed providers fold on every read.
 * @param session - the session the binding belongs to.
 * @param connectorId - the connector every subsequent file and process
 *   operation in this session runs against (until the next binding).
 */
export function bindSessionConnector(session: Session, connectorId: ConnectorId): void {
  session.append('connector/bound', { connectorId })
}
