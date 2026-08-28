/**
 * TCP transport for the connector seam: turns a deployment's connector
 * declarations into registry entries whose links reach a `dsh-connector-agent`
 * on another machine.
 *
 * Each declaration states the target's OS family and working directory. The
 * agent confirms both during the handshake and the link is refused when they
 * disagree, so a mistyped address cannot silently point a session's files and
 * commands at the wrong machine.
 *
 * @module @deepseek-ai/dsh-connector-tcp
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { ConnectorId } from '@deepseek-ai/dsh-connector'
import type { ConnectorOs } from '@deepseek-ai/dsh-connector'
import { openConnectorTcpLink } from './client.ts'

export { openConnectorLinkOverSocket, openConnectorTcpLink } from './client.ts'
export type { ConnectorSocketOptions, ConnectorTcpOptions } from './client.ts'

/** Cordis plugin name. */
export const name = 'connector-tcp'
/** The registry this plugin contributes its declared connectors to. */
export const inject = ['connectors']

/** One declared remote connector. */
export interface ConnectorTcpDeclaration {
  /** Identifier sessions bind to. */
  id: string
  /** Agent host name or address. Prefer a loopback address behind an SSH tunnel. */
  host: string
  /** Agent TCP port. */
  port: number
  /** Target OS family; the agent must report the same one. */
  os: ConnectorOs
  /** Target default working directory; the agent must report the same one. */
  workdir: string
  /**
   * Environment variable holding the shared secret. Preferred over `token`
   * so a deployment file never carries the credential.
   */
  tokenEnv?: string
  /** Inline shared secret, for a deployment that manages this file as a secret. */
  token?: string
  /** Deadline for socket connect plus handshake. Defaults to 10 seconds. */
  connectTimeoutMs?: number
}

/** Configuration of the TCP connector transport. */
export interface Config {
  /** The remote connectors this deployment offers. */
  connectors?: ConnectorTcpDeclaration[]
}

const ConnectorTcpDeclaration: z<ConnectorTcpDeclaration> = z.object({
  id: z.string().required(),
  host: z.string().required(),
  port: z.number().required(),
  os: z.union(['linux', 'macos', 'windows'] as const).required(),
  workdir: z.string().required(),
  tokenEnv: z.string(),
  token: z.string(),
  connectTimeoutMs: z.number().default(10_000),
})

/** Validated plugin config. */
export const Config: z<Config> = z.object({
  connectors: z.array(ConnectorTcpDeclaration).default([]),
})

/**
 * Resolve one declaration's shared secret.
 * @param declaration - the connector declaration.
 * @param env - the process environment `tokenEnv` names.
 * @returns the secret every connection to this agent presents.
 */
export function resolveConnectorToken(
  declaration: ConnectorTcpDeclaration,
  env: Readonly<Record<string, string | undefined>>,
): string {
  if ((declaration.token === undefined) === (declaration.tokenEnv === undefined)) {
    throw new Error(`connector-tcp: connector ${JSON.stringify(declaration.id)} needs exactly one of token or tokenEnv`)
  }
  if (declaration.token !== undefined) {
    if (declaration.token.length === 0) {
      throw new Error(`connector-tcp: connector ${JSON.stringify(declaration.id)} has an empty token`)
    }
    return declaration.token
  }
  const value = env[declaration.tokenEnv as string]
  if (value === undefined || value.length === 0) {
    throw new Error(
      `connector-tcp: connector ${JSON.stringify(declaration.id)} reads its token from ${String(declaration.tokenEnv)}, which is unset or empty`,
    )
  }
  return value
}

/**
 * Register every declared remote connector.
 * @param ctx - context carrying the connector registry.
 * @param config - the deployment's connector declarations.
 */
export function apply(ctx: Context, config: Config): void {
  for (const declaration of config.connectors as ConnectorTcpDeclaration[]) {
    const token = resolveConnectorToken(declaration, process.env)
    const options = {
      id: declaration.id,
      host: declaration.host,
      port: declaration.port,
      os: declaration.os,
      workdir: declaration.workdir,
      token,
      connectTimeoutMs: declaration.connectTimeoutMs as number,
    }
    ctx.connectors.register(
      { id: ConnectorId(declaration.id), os: declaration.os, workdir: declaration.workdir },
      async () => openConnectorTcpLink(options),
    )
  }
}
