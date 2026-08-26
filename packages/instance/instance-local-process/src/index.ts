/**
 * Service Provider for the instance seam backed by a local worker process:
 * each instance is one child harness with its own `DSH_HOME`, its own
 * workspace directory, and its own loopback `/api` server. Isolation here is
 * filesystem-and-process scoped, not kernel scoped — it is the seam's
 * simplest complete implementation, and a container or remote-sandbox
 * provider replaces it without any consumer change.
 *
 * Readiness is the endpoint handshake the seam defines
 * (`INSTANCE_ENDPOINT_FILE_ENV`): the worker binds an OS-assigned port and
 * renames a complete endpoint file into place, and this provider polls for
 * that file rather than parsing the worker's output.
 * @module @deepseek-ai/dsh-instance-local-process
 */

import { mkdir, readFile, rm } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import {
  INSTANCE_ENDPOINT_FILE_ENV,
  type InstanceEndpoint,
  type InstanceProvider,
  type InstanceRuntime,
  type InstanceStartRequest,
} from '@deepseek-ai/dsh-instance'
import type { SubprocessHandle } from '@deepseek-ai/dsh-subprocess'

/** Stable Cordis plugin name. */
export const name = 'instance-local-process'

/** Services required before the provider can register. */
export const inject = ['instances', 'subprocess']

/** Provider name this plugin registers under. */
export const PROVIDER_NAME = 'local-process'

/** Interval between endpoint-handshake polls while a worker is starting. */
const HANDSHAKE_POLL_MS = 50

/** Owner-only permissions for the per-instance state tree. */
const PRIVATE_DIR_MODE = 0o700

/** Plugin configuration. Every value varies by deployment; none is guessed. */
export interface Config {
  /**
   * Executable that boots one worker runtime — the `dsh` binary in an
   * installation, or the Node binary in a source checkout. Resolved through
   * the subprocess seam's executable lookup, so a bare name uses PATH.
   */
  command: string
  /**
   * Arguments handed to {@link command}. They must boot a harness profile
   * that serves `/api` on loopback and performs the endpoint handshake;
   * `@deepseek-ai/dsh-worker` is the bundle that does.
   */
  args: string[]
  /**
   * Absolute directory under which each instance's private tree is created
   * (`<root>/<instanceId>/home` and `<root>/<instanceId>/workspace`). A
   * relative path is resolved against the control plane's working directory.
   */
  root: string
  /**
   * Environment entries added to every worker on top of the subprocess seam's
   * scrubbed base. This is how a deployment forwards the credential the
   * scrub strips — `{ DEEPSEEK_API_KEY: '...' }` — so nothing leaks
   * implicitly.
   */
  env?: Record<string, string>
  /**
   * Parent environment names copied verbatim into every worker. Use it for
   * credentials the control plane itself received; a name that is unset in
   * the parent is skipped.
   */
  forwardEnv?: string[]
  /** How long a worker may take to complete the endpoint handshake. @default 60000 */
  readyTimeoutMs?: number
  /** SIGTERM-to-SIGKILL grace for a worker's process tree. @default 5000 */
  stopGraceMs?: number
  /**
   * Delete an instance's private tree when its worker stops. Off keeps the
   * worker's session logs for inspection after the control plane exits.
   * @default false
   */
  removeStateOnStop?: boolean
}

export const Config: z<Config> = z.object({
  command: z.string().required(),
  args: z.array(String).default([]),
  root: z.string().required(),
  env: z.dict(String).default({}),
  forwardEnv: z.array(String).default([]),
  readyTimeoutMs: z.natural().min(1).default(60_000),
  stopGraceMs: z.natural().min(1).default(5_000),
  removeStateOnStop: z.boolean().default(false),
})

/** The per-instance directory layout this provider owns. */
interface InstanceLayout {
  /** Root of everything this instance owns. */
  root: string
  /** The worker's `DSH_HOME`. */
  home: string
  /** The worker's working directory and default project root. */
  workspace: string
  /** Where the worker publishes its endpoint. */
  endpointFile: string
}

function layoutFor(root: string, request: InstanceStartRequest): InstanceLayout {
  const instanceRoot = join(root, request.id)
  return {
    root: instanceRoot,
    home: join(instanceRoot, 'home'),
    workspace: join(instanceRoot, 'workspace'),
    endpointFile: join(instanceRoot, 'endpoint.json'),
  }
}

/**
 * Read one completed endpoint handshake.
 * @param path - the endpoint file the worker renames into place.
 * @returns the published origin, or `undefined` while the file is absent.
 */
async function readHandshake(path: string): Promise<string | undefined> {
  let raw: string
  try {
    raw = await readFile(path, 'utf8')
  } catch {
    // Absent file is the normal "not ready yet" state; every other read
    // failure on a path this provider just created its parent for would
    // resurface on the next poll or on the deadline.
    return undefined
  }
  // Durable-file boundary: the worker is a separate process, so its output is
  // parsed and validated rather than trusted.
  const parsed: unknown = JSON.parse(raw)
  const origin = (parsed as { origin?: unknown } | null)?.origin
  if (typeof origin !== 'string' || origin === '') {
    throw new Error(`worker endpoint file ${path} does not carry an origin`)
  }
  return origin
}

/** Resolve the environment one worker starts with (explicit entries only; the seam scrubs the rest). */
function workerEnv(config: Config, layout: InstanceLayout): Record<string, string> {
  const forwarded: Record<string, string> = {}
  for (const key of config.forwardEnv ?? []) {
    const value = process.env[key]
    if (value !== undefined) forwarded[key] = value
  }
  return {
    ...forwarded,
    ...config.env ?? {},
    DSH_HOME: layout.home,
    [INSTANCE_ENDPOINT_FILE_ENV]: layout.endpointFile,
  }
}

/**
 * Await the worker's endpoint handshake, failing loud on the three ways it
 * can not happen: the worker exited, the caller gave up, or the deadline
 * passed.
 */
async function awaitHandshake(
  layout: InstanceLayout,
  handle: SubprocessHandle,
  request: InstanceStartRequest,
  readyTimeoutMs: number,
): Promise<InstanceEndpoint> {
  const deadline = Date.now() + readyTimeoutMs
  let exited = false
  // `done` rejects only for spawn-level failures, which the start path below
  // observes through this same loop's exit branch.
  void handle.done.then(() => { exited = true }, () => { exited = true })
  for (;;) {
    const origin = await readHandshake(layout.endpointFile)
    if (origin !== undefined) return { origin, root: layout.root }
    if (exited) throw new Error(`worker for instance ${request.label} exited before publishing its endpoint`)
    if (request.signal.aborted) throw new Error(`start of instance ${request.label} was cancelled`)
    if (Date.now() >= deadline) {
      throw new Error(`worker for instance ${request.label} did not publish an endpoint within ${String(readyTimeoutMs)}ms`)
    }
    await new Promise<void>((settle) => { setTimeout(settle, HANDSHAKE_POLL_MS) })
  }
}

/**
 * Build the provider over one resolved configuration.
 * @param ctx - plugin context carrying the subprocess seam.
 * @param config - validated plugin configuration.
 * @returns the provider implementation registered with the instance registry.
 */
export function createLocalProcessProvider(ctx: Context, config: Config): InstanceProvider {
  const root = resolve(config.root)
  const stopGraceMs = config.stopGraceMs ?? 5_000
  const readyTimeoutMs = config.readyTimeoutMs ?? 60_000
  return {
    name: PROVIDER_NAME,
    async start(request: InstanceStartRequest): Promise<InstanceRuntime> {
      const layout = layoutFor(root, request)
      // A reused instance directory would hand back the previous worker's
      // endpoint before the new one binds.
      await rm(layout.root, { recursive: true, force: true })
      await mkdir(layout.home, { recursive: true, mode: PRIVATE_DIR_MODE })
      await mkdir(layout.workspace, { recursive: true, mode: PRIVATE_DIR_MODE })
      const handle = ctx.subprocess.spawn({
        argv: [config.command, ...config.args],
        cwd: layout.workspace,
        // A worker's diagnostics are the only place a boot failure is
        // legible; inheriting puts them on the control plane's own streams
        // rather than in a buffer nothing reads.
        stdio: { stdin: 'ignore', stdout: 'inherit', stderr: 'inherit' },
        graceMs: stopGraceMs,
        env: workerEnv(config, layout),
      })
      const stop = async (): Promise<void> => {
        handle.terminate()
        await handle.waitForExit()
        if (config.removeStateOnStop === true) await rm(layout.root, { recursive: true, force: true })
      }
      try {
        const endpoint = await awaitHandshake(layout, handle, request, readyTimeoutMs)
        return { endpoint, stop }
      } catch (error) {
        // The registry never sees this handle, so this call is the only one
        // that can still reap the worker it started.
        await stop()
        throw error
      }
    },
  }
}

/**
 * Register the local-process instance provider.
 * @param ctx - plugin context carrying the instance registry and subprocess seam.
 * @param config - validated {@link Config}.
 */
export function apply(ctx: Context, config: Config): void {
  const provider = createLocalProcessProvider(ctx, config)
  ctx.effect(() => ctx.instances.registerProvider(provider), 'instance-local-process: provider')
}
