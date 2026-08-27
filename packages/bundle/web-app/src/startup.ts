/**
 * The web app's command-line provider: it parses the `dsh --profile web` flag
 * family (`--host`, `--port`, `--trusted-host`, `--configuration-plane`,
 * `--no-open`) and its `--help`
 * text, then provides the immutable values as {@link WEB_STARTUP_SERVICE}.
 * Ordinary rows inject that service before reading it from lazy config.
 * @module @deepseek-ai/dsh-web-app/startup
 */

import { Command } from 'commander'
import type { Context } from '@deepseek-ai/cordis'
import { parseCmdline } from '@deepseek-ai/dsh-cmdline'
import {
  DEFAULT_CONFIGURATION_PLANE_SCOPE, type ConfigurationPlaneScope,
} from '@deepseek-ai/dsh-client-connection'

/** Stable Cordis plugin name. */
export const name = 'web-startup'

/** Services required before the flags can be resolved. */
export const inject = ['cmdlineArgs']

/** Service provided by this ordinary plugin and injected by flag-configured rows. */
export const WEB_STARTUP_SERVICE = 'webStartup'

/** What the web rows read from {@link WEB_STARTUP_SERVICE}. */
export interface WebStartupValues {
  /** Whether this invocation opens the default browser after startup. */
  openBrowser: boolean
  /** `--host`, absent when the invocation did not name one. */
  host?: string
  /** `--port`, absent when the invocation did not name one. */
  port?: number
  /** Explicit `--trusted-host` authorities, in argument order. */
  trustedHosts: string[]
  /** `--configuration-plane`, defaulting to the loopback scope. */
  configurationPlane: ConfigurationPlaneScope
}

/** The web flag family, as commander parsed it. */
interface WebOptions {
  host?: string
  open: boolean
  port?: string
  trustedHost?: string[]
  configurationPlane?: string
}

/** The scopes `--configuration-plane` accepts, in help order. */
const CONFIGURATION_PLANE_SCOPES = ['loopback', 'trusted-hosts'] as const satisfies readonly ConfigurationPlaneScope[]

/** Resolve `--configuration-plane`; an unknown scope is a usage error, an absent flag the default. */
function resolveConfigurationPlane(program: Command, value: string | undefined): ConfigurationPlaneScope {
  if (value === undefined) return DEFAULT_CONFIGURATION_PLANE_SCOPE
  const scope = CONFIGURATION_PLANE_SCOPES.find(candidate => candidate === value)
  if (scope === undefined) {
    program.error(
      `error: --configuration-plane must be one of ${CONFIGURATION_PLANE_SCOPES.join(', ')}, got ${JSON.stringify(value)}`,
    )
  }
  return scope
}

/**
 * This app's command: its flags, its description, and its help text.
 * @returns a fresh program, so one process can parse more than once (tests).
 */
function webCommand(): Command {
  return new Command()
    .name('dsh --profile web')
    .description('Serve the DeepSeek Harness browser UI.')
    .helpOption('-h, --help', 'show this help')
    .option('--host <host>', 'bind host')
    .option('--no-open', 'do not open the Web UI in the default browser')
    .option('--port <port>', 'listen port; pass 0 to let the OS pick a free one')
    .option('--trusted-host <authority...>', 'extra authority the /api browser-trust fence accepts (host or host:port; repeatable)')
    .option(
      '--configuration-plane <scope>',
      'who may read and write settings, credentials, and agent presets: loopback (default), or trusted-hosts to also serve every --trusted-host authority',
    )
    .addHelpText('after', `
Examples:
  dsh --profile web                          serve on the composed host and port
  dsh --profile web --no-open                serve without opening a browser
  dsh --profile web --port 8080              serve on another port

--configuration-plane trusted-hosts lets a remote browser configure model
providers and credentials. The trust fence is a DNS-rebinding defense, not
authentication, so anyone who can reach the port gets that access: use it only
behind your own authentication.
`)
}

/**
 * Parse and provide the Web invocation as an ordinary Cordis service. The
 * command's action publishes the flags this invocation named; `--host 0.0.0.0`
 * or a non-numeric `--port` is a usage error, so on rejection (and on `--help`)
 * nothing is provided.
 * @param ctx - plugin context carrying the command line.
 */
export function apply(ctx: Context): void {
  const program = webCommand()
  program.action(() => {
    const options = program.opts<WebOptions>()
    if (options.host === '0.0.0.0') {
      program.error('error: --host 0.0.0.0 is intentionally not supported yet for safety: it would expose remote code execution to the network; use 127.0.0.1 instead')
    }
    if (options.port !== undefined && !/^\d+$/.test(options.port)) {
      program.error(`error: --port must be a number, got ${JSON.stringify(options.port)}`)
    }
    ctx.provide(WEB_STARTUP_SERVICE, {
      openBrowser: options.open,
      ...options.host !== undefined && { host: options.host },
      ...options.port !== undefined && { port: Number(options.port) },
      trustedHosts: options.trustedHost ?? [],
      configurationPlane: resolveConfigurationPlane(program, options.configurationPlane),
    } satisfies WebStartupValues)
  })
  parseCmdline(ctx, program)
}
