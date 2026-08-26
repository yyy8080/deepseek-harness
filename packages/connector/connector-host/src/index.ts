/**
 * The connector host: the target-side execution world, the agent that serves it
 * over TCP, and the plugin that registers this machine as an in-process
 * connector.
 *
 * Mounting this plugin gives a deployment a connector that needs no network at
 * all — the harness machine itself — while the same host code runs behind the
 * `dsh-connector-agent` bin on a Linux or Windows target. One implementation
 * means the local and remote worlds cannot drift in path identity, atomic
 * writes, or process termination.
 *
 * @module @deepseek-ai/dsh-connector-host
 */

import { resolve } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { ConnectorId } from '@deepseek-ai/dsh-connector'
import type {} from '@deepseek-ai/dsh-connector'
import { createConnectorHost, hostConnectorOs } from './host.ts'

export { createConnectorHost, hostConnectorOs } from './host.ts'
export type { ConnectorHostOptions } from './host.ts'
export { serveConnector, wireError } from './server.ts'
export type { ConnectorServeOptions, ConnectorServer } from './server.ts'
export { CONNECTOR_AGENT_USAGE, CONNECTOR_TOKEN_ENV, parseConnectorAgentArgs, runConnectorAgent } from './agent.ts'
export type { ConnectorAgentInvocation } from './agent.ts'

/** Cordis plugin name. */
export const name = 'connector-host'
/** The registry this plugin contributes its in-process connector to. */
export const inject = ['connectors']

/** Configuration of the in-process connector. */
export interface Config {
  /** Identifier sessions bind to. Defaults to `local`. */
  id?: string
  /** Absolute default working directory. Defaults to the harness process cwd. */
  workdir?: string
}

/** Validated plugin config. */
export const Config: z<Config> = z.object({
  id: z.string().default('local'),
  workdir: z.string().default(process.cwd()),
})

/**
 * Register this machine as a connector.
 * @param ctx - context carrying the connector registry.
 * @param config - the connector's identifier and working directory.
 */
export function apply(ctx: Context, config: Config): void {
  const id = config.id as string
  const workdir = resolve(config.workdir as string)
  ctx.connectors.register(
    { id: ConnectorId(id), os: hostConnectorOs(), workdir },
    async () => createConnectorHost({ id, workdir }),
  )
}
