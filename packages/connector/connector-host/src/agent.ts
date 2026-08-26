/**
 * Command line of the `dsh-connector-agent` program: argument parsing and the
 * run loop that keeps one agent listening until the process is signalled.
 * @module @deepseek-ai/dsh-connector-host/agent
 */

import { resolve } from 'node:path'
import { hostConnectorOs } from './host.ts'
import { serveConnector } from './server.ts'

/** Everything the agent reads from its argv and environment. */
export interface ConnectorAgentInvocation {
  /** Interface address to bind. */
  host: string
  /** TCP port to bind; `0` asks the operating system for a free one. */
  port: number
  /** Shared secret clients must present. */
  token: string
  /** Absolute default working directory of the served world. */
  workdir: string
}

/** Environment variable carrying the agent's shared secret when `--token` is omitted. */
export const CONNECTOR_TOKEN_ENV = 'DSH_CONNECTOR_TOKEN'

const OPTIONS = ['host', 'port', 'workdir', 'token']

/** Text `--help` prints. */
export const CONNECTOR_AGENT_USAGE = `Usage: dsh-connector-agent [options]

  --host <address>   interface to bind (default 127.0.0.1)
  --port <port>      port to bind, 0 for any free port (default 8765)
  --workdir <dir>    default working directory (default the process cwd)
  --token <secret>   shared secret; ${CONNECTOR_TOKEN_ENV} is used when omitted
  --help             print this message
`

/**
 * Parse the agent's invocation.
 * @param argv - arguments after the program name.
 * @param env - the process environment supplying the token fallback.
 * @returns the resolved invocation.
 */
export function parseConnectorAgentArgs(
  argv: readonly string[],
  env: Readonly<Record<string, string | undefined>>,
): ConnectorAgentInvocation {
  const values = new Map<string, string>()
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index] as string
    if (!flag.startsWith('--')) throw new Error(`dsh-connector-agent: unexpected argument ${JSON.stringify(flag)}`)
    const option = flag.slice(2)
    if (!OPTIONS.includes(option)) throw new Error(`dsh-connector-agent: unknown option ${flag}`)
    const value = argv[index + 1]
    if (value === undefined) throw new Error(`dsh-connector-agent: ${flag} needs a value`)
    values.set(option, value)
  }
  const port = Number(values.get('port') ?? '8765')
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error('dsh-connector-agent: --port must be an integer between 0 and 65535')
  }
  const token = values.get('token') ?? env[CONNECTOR_TOKEN_ENV] ?? ''
  if (token.length === 0) {
    throw new Error(`dsh-connector-agent: set --token or ${CONNECTOR_TOKEN_ENV} to a non-empty shared secret`)
  }
  return {
    host: values.get('host') ?? '127.0.0.1',
    port,
    token,
    workdir: resolve(values.get('workdir') ?? process.cwd()),
  }
}

/**
 * Start the agent and keep it running until the process receives SIGINT or
 * SIGTERM.
 * @param argv - arguments after the program name.
 * @returns once the server has stopped.
 */
export async function runConnectorAgent(argv: readonly string[]): Promise<void> {
  if (argv.includes('--help')) {
    process.stdout.write(CONNECTOR_AGENT_USAGE)
    return
  }
  const invocation = parseConnectorAgentArgs(argv, process.env)
  const server = await serveConnector(invocation)
  process.stdout.write(
    `dsh-connector-agent listening on ${invocation.host}:${server.port} (${hostConnectorOs()}, workdir ${invocation.workdir})\n`,
  )
  await new Promise<void>((done) => {
    const stop = (): void => { void server.close().then(done, done) }
    process.once('SIGINT', stop)
    process.once('SIGTERM', stop)
  })
}
