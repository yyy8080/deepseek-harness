/**
 * @deepseek-ai/dsh-worker — the isolated-runtime bundle's glue plugin plus the
 * bundle patch (`cordis.patch.yml`, declared by the `dsh.bundle.patch`
 * manifest field). The bundle is the browser surface's host half without the
 * browser: `/api` over loopback, no frontend dist, no client plugin roster,
 * no default-browser handoff.
 *
 * The plugin owns readiness publication. A supervised worker performs the
 * instance seam's endpoint handshake — it renames a complete endpoint file
 * into place once the whole Loader tree has settled — so its supervisor can
 * let it bind an OS-assigned port and still learn where it answers. An
 * unsupervised worker prints the same origin instead.
 * @module @deepseek-ai/dsh-worker
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'
import type {} from '@deepseek-ai/cordis-plugin-loader'
import type {} from '@deepseek-ai/dsh-host-webserver'
import type {} from '@deepseek-ai/dsh-system-prompt'

/** Stable Cordis plugin name. */
export const name = 'worker'

/** Services required before the worker runtime can publish readiness. */
export const inject = ['webServer']

/** Owner-only permissions on the handshake file: it names a live control port. */
const ENDPOINT_FILE_MODE = 0o600

/** The loopback address a worker always binds and always publishes. */
const LOOPBACK_HOST = '127.0.0.1'

/** Plugin config: how this worker announces the origin it bound. */
export interface Config {
  /**
   * Absolute path of the instance seam's endpoint handshake file. Set by a
   * supervising provider through `DSH_INSTANCE_ENDPOINT_FILE`; absent when a
   * person boots the worker by hand, in which case the origin is printed.
   */
  endpointFile?: string
  /**
   * Register the model-visible isolation notice. A worker's agent shares no
   * filesystem, session store, or shell state with the control plane, and
   * saying so prevents it from offering to inspect things it cannot reach.
   * @default true
   */
  surfaceContext?: boolean
}

export const Config: z<Config> = z.object({
  endpointFile: z.string(),
  surfaceContext: z.boolean().default(true),
})

/** Model-visible orientation for a session running inside an isolated worker. */
const WORKER_SURFACE_PROMPT = 'You are running inside an isolated DeepSeek Harness runtime that was allocated for this conversation alone. '
  + 'Its filesystem, harness home, session store, and shell state are private to it: nothing you create here is visible to other conversations, '
  + 'and nothing another conversation created is visible to you. '
  + 'Your working directory is this runtime\'s own workspace, not the user\'s machine, so do not offer to inspect or modify files outside it.'

/** Resolve the loopback origin this worker bound. */
function localOrigin(ctx: Context): string {
  const port = ctx.get('webServer')?.port
  if (port === undefined) throw new Error('worker: webServer service missing while resolving the worker origin')
  return `http://${LOOPBACK_HOST}:${String(port)}`
}

/**
 * Publish the bound origin: the handshake file when supervised, the console
 * otherwise. Both are readiness signals, so both wait for the Loader tree.
 * @param ctx - plugin context carrying the bound server.
 * @param endpointFile - the handshake path, or `undefined` when unsupervised.
 * @returns a promise settling once the origin has been published.
 */
async function publishOrigin(ctx: Context, endpointFile: string | undefined): Promise<void> {
  const origin = localOrigin(ctx)
  if (endpointFile === undefined) {
    console.log(`dsh worker: ${origin}`)
    return
  }
  await writeFileAtomic(endpointFile, `${JSON.stringify({ origin })}\n`, {
    mode: ENDPOINT_FILE_MODE,
    dirMode: 0o700,
  })
}

/**
 * Mount the worker runtime: the isolation prompt section and the readiness
 * announcement.
 * @param ctx - plugin context carrying the webServer service.
 * @param config - validated {@link Config}.
 */
export function apply(ctx: Context, config: Config): void {
  if (config.surfaceContext !== false) {
    ctx.inject(['systemPrompt'], (promptCtx) => {
      promptCtx.systemPrompt.section({
        name: 'app:worker-surface',
        order: -98,
        text: () => WORKER_SURFACE_PROMPT,
      })
    })
  }
  // A supervisor treats the handshake as "this worker serves requests now", so
  // it must not land while sibling rows — the /api route owner above all — are
  // still mounting. A hand-built tree without a Loader is already complete.
  const settled = ctx.get('loader')?.await()
  const announce = (): void => {
    void publishOrigin(ctx, config.endpointFile).catch((error: unknown) => {
      // A worker whose supervisor can never find it is dead weight: report and
      // let the supervisor's readiness deadline reap the process.
      console.error(`worker: could not publish the worker origin: ${String(error)}`)
    })
  }
  if (settled === undefined) announce()
  else {
    void settled.then(() => {
      // The tree can be disposed while the boot is in flight (an early
      // SIGTERM); publishing an endpoint for a dying server would only make
      // its supervisor wait for a worker that is already gone.
      if (ctx.get('webServer') !== undefined) announce()
    // The Loader reports a failed boot; this row only stays quiet, and the
    // supervisor observes the worker's exit instead of a handshake.
    }, () => {})
  }
}
