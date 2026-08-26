import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { INSTANCE_ENDPOINT_FILE_ENV, InstanceId, type InstanceStartRequest } from '@deepseek-ai/dsh-instance'
import type { SubprocessHandle, SubprocessSpawnSpec } from '@deepseek-ai/dsh-subprocess'
import * as LocalProcessProvider from '@deepseek-ai/dsh-instance-local-process'
import { createLocalProcessProvider, PROVIDER_NAME, type Config } from '@deepseek-ai/dsh-instance-local-process'

/** One spawn the fake seam recorded, plus the levers a test drives it with. */
interface FakeWorker {
  spec: SubprocessSpawnSpec
  handle: SubprocessHandle
  terminated: boolean
  /** Settle the worker's `done`, which is how the provider observes an early exit. */
  exit: () => void
}

/**
 * A subprocess seam that records spawns and starts no process. The provider's
 * readiness is the endpoint file, so a test publishes the handshake itself.
 */
class FakeSubprocess {
  readonly workers: FakeWorker[] = []

  spawn(spec: SubprocessSpawnSpec): SubprocessHandle {
    let exit = (): void => {}
    const done = new Promise<never>((_resolve, reject) => {
      exit = () => { reject(new Error('worker exited')) }
    })
    // The provider only ever observes settlement, and an unobserved rejection
    // before that would fail the run.
    done.catch(() => {})
    const worker: FakeWorker = {
      spec,
      terminated: false,
      exit: () => { exit() },
      handle: {
        pid: 4242,
        stdin: undefined,
        stdout: undefined,
        stderr: undefined,
        collected: {} as SubprocessHandle['collected'],
        done: done as unknown as SubprocessHandle['done'],
        terminate: () => { worker.terminated = true },
        waitForExit: () => Promise.resolve(true),
      },
    }
    this.workers.push(worker)
    return worker.handle
  }
}

let root: string
let ctx: Context
let subprocess: FakeSubprocess

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'dsh-instance-local-'))
  ctx = new Context()
  subprocess = new FakeSubprocess()
  ctx.provide('subprocess', subprocess as never)
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

function request(id = 'inst-1', label = 'alpha'): InstanceStartRequest {
  return { id: InstanceId(id), label, signal: new AbortController().signal }
}

/**
 * Publish the handshake the worker would rename into place, once the provider
 * has created the tree it spawns into.
 */
async function publish(index: number, body: unknown): Promise<void> {
  const spec = await spawned(index)
  const file = spec.env?.[INSTANCE_ENDPOINT_FILE_ENV]
  if (file === undefined) throw new Error('worker was spawned without a handshake path')
  await writeFile(file, JSON.stringify(body), 'utf8')
}

/** Resolve once the provider has reached its spawn, which follows its `mkdir`s. */
async function spawned(index: number): Promise<SubprocessSpawnSpec> {
  for (;;) {
    const worker = subprocess.workers[index]
    if (worker) return worker.spec
    await new Promise<void>((settle) => { setTimeout(settle, 1) })
  }
}

function config(overrides: Partial<Config> = {}): Config {
  return { command: 'dsh', args: ['--profile', 'worker'], root, readyTimeoutMs: 2_000, ...overrides }
}

describe('local-process instance provider', () => {
  it('gives each worker its own home, workspace, and handshake path', async () => {
    const provider = createLocalProcessProvider(ctx, config({ env: { DEEPSEEK_API_KEY: 'k' } }))
    const starting = provider.start(request())
    await publish(0, { origin: 'http://127.0.0.1:41234' })
    const runtime = await starting

    expect(runtime.endpoint).toEqual({ origin: 'http://127.0.0.1:41234', root: join(root, 'inst-1') })
    const [worker] = subprocess.workers
    expect(worker?.spec.argv).toEqual(['dsh', '--profile', 'worker'])
    expect(worker?.spec.cwd).toBe(join(root, 'inst-1', 'workspace'))
    expect(worker?.spec.env).toMatchObject({
      DEEPSEEK_API_KEY: 'k',
      DSH_HOME: join(root, 'inst-1', 'home'),
      [INSTANCE_ENDPOINT_FILE_ENV]: join(root, 'inst-1', 'endpoint.json'),
    })
    expect((await stat(join(root, 'inst-1', 'home'))).mode & 0o777).toBe(0o700)
  })

  it('resolves a relative root against the control plane working directory', async () => {
    const provider = createLocalProcessProvider(ctx, config({ root: 'relative-instances' }))
    void provider.start(request()).catch(() => {})
    const spec = await spawned(0)

    expect(spec.cwd).toBe(join(process.cwd(), 'relative-instances', 'inst-1', 'workspace'))
    await rm(join(process.cwd(), 'relative-instances'), { recursive: true, force: true })
  })

  it('forwards only parent environment names that are set', async () => {
    process.env.DSH_TEST_FORWARDED = 'present'
    try {
      const provider = createLocalProcessProvider(
        ctx,
        config({ forwardEnv: ['DSH_TEST_FORWARDED', 'DSH_TEST_ABSENT'] }),
      )
      const starting = provider.start(request())
      await publish(0, { origin: 'http://127.0.0.1:1' })
      await starting

      const env = subprocess.workers[0]?.spec.env ?? {}
      expect(env.DSH_TEST_FORWARDED).toBe('present')
      expect('DSH_TEST_ABSENT' in env).toBe(false)
    } finally {
      delete process.env.DSH_TEST_FORWARDED
    }
  })

  it('starts each worker from the seam-scrubbed base when nothing is configured', async () => {
    const provider = createLocalProcessProvider(ctx, { command: 'dsh', args: [], root })
    void provider.start(request()).catch(() => {})
    const spec = await spawned(0)

    expect(Object.keys(spec.env ?? {}).sort()).toEqual([INSTANCE_ENDPOINT_FILE_ENV, 'DSH_HOME'].sort())
    expect(spec.graceMs).toBe(5_000)
  })

  it('replaces a previous instance tree so a stale endpoint is never read', async () => {
    const stale = join(root, 'inst-1')
    await mkdir(stale, { recursive: true })
    await writeFile(join(stale, 'leftover.txt'), 'stale', 'utf8')

    const provider = createLocalProcessProvider(ctx, config())
    const starting = provider.start(request())
    await publish(0, { origin: 'http://127.0.0.1:2' })
    const runtime = await starting

    expect(runtime.endpoint.origin).toBe('http://127.0.0.1:2')
    await expect(readFile(join(stale, 'leftover.txt'), 'utf8')).rejects.toThrow()
  })

  it('reaps the worker and rethrows when it exits before publishing', async () => {
    const provider = createLocalProcessProvider(ctx, config())
    const starting = provider.start(request())
    await spawned(0)
    subprocess.workers[0]?.exit()

    await expect(starting).rejects.toThrow(/exited before publishing its endpoint/)
    expect(subprocess.workers[0]?.terminated).toBe(true)
  })

  it('fails the start when the caller cancels it', async () => {
    const abort = new AbortController()
    const provider = createLocalProcessProvider(ctx, config())
    const starting = provider.start({ id: InstanceId('inst-1'), label: 'alpha', signal: abort.signal })
    await spawned(0)
    abort.abort()

    await expect(starting).rejects.toThrow(/was cancelled/)
  })

  it('fails the start when the handshake misses its deadline', async () => {
    const provider = createLocalProcessProvider(ctx, config({ readyTimeoutMs: 1 }))
    await expect(provider.start(request())).rejects.toThrow(/did not publish an endpoint within 1ms/)
  })

  it('fails the start when the published handshake carries no origin', async () => {
    const provider = createLocalProcessProvider(ctx, config())
    const starting = provider.start(request())
    await publish(0, { origin: '' })

    await expect(starting).rejects.toThrow(/does not carry an origin/)
  })

  it('keeps the instance tree on stop by default and deletes it when asked', async () => {
    const kept = createLocalProcessProvider(ctx, config())
    const keeping = kept.start(request())
    await publish(0, { origin: 'http://127.0.0.1:1' })
    await (await keeping).stop()
    expect(subprocess.workers[0]?.terminated).toBe(true)
    expect((await stat(join(root, 'inst-1'))).isDirectory()).toBe(true)

    const removing = createLocalProcessProvider(ctx, config({ removeStateOnStop: true }))
    const starting = removing.start(request('inst-2', 'beta'))
    await publish(1, { origin: 'http://127.0.0.1:2' })
    await (await starting).stop()
    await expect(stat(join(root, 'inst-2'))).rejects.toThrow()
  })

  it('registers itself with the instance registry under the provider name', async () => {
    const registered: string[] = []
    ctx.provide('instances', {
      registerProvider: (provider: { name: string }) => {
        registered.push(provider.name)
        return () => { registered.pop() }
      },
    } as never)

    const fiber = await ctx.plugin(LocalProcessProvider, config())
    expect(registered).toEqual([PROVIDER_NAME])
    await fiber.dispose()
    expect(registered).toEqual([])
  })
})
