/**
 * Command line of the `dsh-connector-agent` program: argument parsing and the
 * run loop that keeps one agent serving until the process is signalled.
 * @module @deepseek-ai/dsh-connector-host/agent
 */

import { hostname } from 'node:os'
import { resolve } from 'node:path'
import { runConnectorAttachment } from './attach.ts'
import { createConnectorHost, hostConnectorOs } from './host.ts'
import { serveConnector } from './server.ts'

/** Facts common to both ways of reaching a harness. */
interface ConnectorAgentCommon {
  /** Shared secret the harness must present in its handshake. */
  token: string
  /** Absolute default working directory of the served world. */
  workdir: string
}

/** The agent waits for the harness to dial it. */
export interface ConnectorAgentListen extends ConnectorAgentCommon {
  mode: 'listen'
  /** Interface address to bind. */
  host: string
  /** TCP port to bind; `0` asks the operating system for a free one. */
  port: number
}

/** The agent dials the harness and is served over the upgraded connection. */
export interface ConnectorAgentAttach extends ConnectorAgentCommon {
  mode: 'attach'
  /** Absolute `http:` or `https:` URL of the deployment's attach endpoint. */
  url: string
  /** Operator-facing name the deployment shows for this machine. */
  label: string
}

/** Everything the agent reads from its argv and environment. */
export type ConnectorAgentInvocation = ConnectorAgentListen | ConnectorAgentAttach

/** Environment variable carrying the agent's shared secret when `--token` is omitted. */
export const CONNECTOR_TOKEN_ENV = 'DSH_CONNECTOR_TOKEN'

/** Environment variable carrying the attach endpoint when `--attach` is omitted. */
export const CONNECTOR_ATTACH_ENV = 'DSH_CONNECTOR_ATTACH'

/** Delay between attach attempts, in milliseconds. */
const ATTACH_RETRY_DELAY_MS = 5000

const OPTIONS = ['host', 'port', 'workdir', 'token', 'attach', 'label']

/** Text `--help` prints. */
export const CONNECTOR_AGENT_USAGE = `Usage: dsh-connector-agent [options]

  --attach <url>     dial this deployment's attach endpoint instead of listening;
                     ${CONNECTOR_ATTACH_ENV} is used when omitted
  --label <name>     name the deployment shows for this machine (default the hostname)
  --host <address>   interface to bind in listen mode (default 127.0.0.1)
  --port <port>      port to bind in listen mode, 0 for any free port (default 8765)
  --workdir <dir>    default working directory (default the process cwd)
  --token <secret>   shared secret; ${CONNECTOR_TOKEN_ENV} is used when omitted
  --help             print this message
`

/**
 * Parse the agent's invocation.
 * @param argv - arguments after the program name.
 * @param env - the process environment supplying the token and endpoint fallbacks.
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
  const token = values.get('token') ?? env[CONNECTOR_TOKEN_ENV] ?? ''
  if (token.length === 0) {
    throw new Error(`dsh-connector-agent: set --token or ${CONNECTOR_TOKEN_ENV} to a non-empty shared secret`)
  }
  const workdir = resolve(values.get('workdir') ?? process.cwd())
  const attach = values.get('attach') ?? env[CONNECTOR_ATTACH_ENV]
  if (attach !== undefined) {
    for (const conflicting of ['host', 'port'] as const) {
      if (values.has(conflicting)) {
        throw new Error(`dsh-connector-agent: --${conflicting} is a listen-mode option and cannot be combined with --attach`)
      }
    }
    return { mode: 'attach', url: attachUrl(attach), label: values.get('label') ?? hostname(), token, workdir }
  }
  if (values.has('label')) {
    throw new Error('dsh-connector-agent: --label names the machine to a deployment and requires --attach')
  }
  const port = Number(values.get('port') ?? '8765')
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error('dsh-connector-agent: --port must be an integer between 0 and 65535')
  }
  return { mode: 'listen', host: values.get('host') ?? '127.0.0.1', port, token, workdir }
}

/** Refuse an endpoint the agent cannot dial, at parse time rather than on the first attempt. */
function attachUrl(value: string): string {
  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw new Error(`dsh-connector-agent: --attach ${JSON.stringify(value)} is not an absolute URL`)
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error(`dsh-connector-agent: --attach must name an http: or https: endpoint, not ${url.protocol}`)
  }
  return url.href
}

/** Resolve once the process receives SIGINT or SIGTERM. */
function untilSignalled(): { signal: AbortSignal; release: () => void } {
  const controller = new AbortController()
  const stop = (): void => { controller.abort() }
  process.once('SIGINT', stop)
  process.once('SIGTERM', stop)
  return {
    signal: controller.signal,
    release: () => {
      process.off('SIGINT', stop)
      process.off('SIGTERM', stop)
    },
  }
}

/**
 * Start the agent and keep it running until the process receives SIGINT or
 * SIGTERM.
 * @param argv - arguments after the program name.
 * @returns once the agent has stopped serving.
 */
export async function runConnectorAgent(argv: readonly string[]): Promise<void> {
  if (argv.includes('--help')) {
    process.stdout.write(CONNECTOR_AGENT_USAGE)
    return
  }
  const invocation = parseConnectorAgentArgs(argv, process.env)
  const report = (message: string): void => { process.stdout.write(`${message}\n`) }
  if (invocation.mode === 'attach') {
    const link = await createConnectorHost({ workdir: invocation.workdir })
    const stopper = untilSignalled()
    report(
      `dsh-connector-agent dialling ${invocation.url} (${hostConnectorOs()}, workdir ${invocation.workdir})`,
    )
    try {
      await runConnectorAttachment({
        url: invocation.url,
        token: invocation.token,
        label: invocation.label,
        link,
        retryDelayMs: ATTACH_RETRY_DELAY_MS,
        report,
      }, stopper.signal)
    } finally {
      stopper.release()
      await link.close()
    }
    return
  }
  const server = await serveConnector(invocation)
  report(
    `dsh-connector-agent listening on ${invocation.host}:${String(server.port)} (${hostConnectorOs()}, workdir ${invocation.workdir})`,
  )
  const stopper = untilSignalled()
  await new Promise<void>((done) => {
    stopper.signal.addEventListener('abort', () => { void server.close().then(done, done) }, { once: true })
  })
  stopper.release()
}
