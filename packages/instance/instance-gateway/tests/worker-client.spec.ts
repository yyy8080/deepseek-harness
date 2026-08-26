import { afterEach, describe, expect, it, vi } from 'vitest'
import type { MuxFrame, RpcRequest } from '@deepseek-ai/dsh-host-apiproxy'
import { SessionId } from '@deepseek-ai/dsh-session'
import { WorkerApiClient } from '@deepseek-ai/dsh-instance-gateway'
import { startFakeWorker, type FakeWorker } from './fake-worker.ts'

const workers: FakeWorker[] = []

afterEach(async () => {
  await Promise.all(workers.splice(0).map(worker => worker.close()))
})

async function worker(handle?: Parameters<typeof startFakeWorker>[0]): Promise<FakeWorker> {
  const started = await startFakeWorker(handle)
  workers.push(started)
  return started
}

function subscribed(sessionId: string): MuxFrame {
  return { type: 'session/subscribed', sessionId: SessionId(sessionId), lastSeq: 0 }
}

/** Read `count` frames off a stream, then let the caller stop it. */
async function take(
  frames: AsyncIterable<RpcRequest<MuxFrame>>,
  count: number,
): Promise<RpcRequest<MuxFrame>[]> {
  const seen: RpcRequest<MuxFrame>[] = []
  for await (const frame of frames) {
    seen.push(frame)
    if (seen.length === count) return seen
  }
  return seen
}

describe('WorkerApiClient', () => {
  it('addresses unary calls at the instance origin, not the control plane', async () => {
    const instance = await worker((method, payload) =>
      method === 'session.create'
        ? { ok: true, value: { sessionId: (payload as { sessionId?: string }).sessionId ?? 'minted' } }
        : undefined)
    const client = new WorkerApiClient(instance.origin, 5_000)

    const response = await client.sessions.create({ sessionId: SessionId('s-1') })

    expect(response.result).toEqual({ ok: true, value: { sessionId: 's-1' } })
    expect(instance.calls).toEqual([{ method: 'session.create', payload: { sessionId: 's-1' } }])
  })

  it('carries mux frames over the downlink and signals the stream is open', async () => {
    const instance = await worker()
    const client = new WorkerApiClient(instance.origin, 5_000)
    const abort = new AbortController()
    const opened = vi.fn()

    const reading = take(client.events.mux({}, abort.signal, opened), 2)
    await instance.awaitDownlinks(1)
    instance.pushMux('r-1', subscribed('a'))
    instance.pushMux('r-2', subscribed('b'))

    expect((await reading).map(frame => frame.rpcId)).toEqual(['r-1', 'r-2'])
    expect(opened).toHaveBeenCalledTimes(1)
    abort.abort()
  })

  it('carries host frames on their own downlink', async () => {
    const instance = await worker()
    const client = new WorkerApiClient(instance.origin, 5_000)
    const abort = new AbortController()

    const reading = client.events.host({}, abort.signal)[Symbol.asyncIterator]().next()
    await instance.awaitDownlinks(1)
    instance.pushHost('h-1', { type: 'host/session-removed', sessionId: SessionId('a') })

    expect((await reading).value).toEqual({
      rpcId: 'h-1',
      payload: { type: 'host/session-removed', sessionId: 'a' },
    })
    abort.abort()
  })

  it('drops a frame that fails either parse level and keeps the stream', async () => {
    const reported = vi.spyOn(console, 'error').mockImplementation(() => {})
    const instance = await worker()
    const client = new WorkerApiClient(instance.origin, 5_000)
    const abort = new AbortController()

    const reading = take(client.events.mux({}, abort.signal), 1)
    await instance.awaitDownlinks(1)
    instance.pushRawMux('not json')
    instance.pushRawMux(JSON.stringify({ type: 'server-request', rpcId: 'r-0', method: 'events.mux', payload: { type: 'nope' } }))
    instance.pushMux('r-1', subscribed('a'))

    expect((await reading).map(frame => frame.rpcId)).toEqual(['r-1'])
    expect(reported).toHaveBeenCalledTimes(2)
    abort.abort()
    reported.mockRestore()
  })

  it('ends the stream when the instance closes its downlink', async () => {
    const instance = await worker()
    const client = new WorkerApiClient(instance.origin, 5_000)
    const abort = new AbortController()

    const reading = take(client.events.mux({}, abort.signal), 10)
    await instance.awaitDownlinks(1)
    instance.pushMux('r-1', subscribed('a'))
    instance.closeDownlinks()

    expect((await reading).map(frame => frame.rpcId)).toEqual(['r-1'])
  })

  it('ends the stream when the downlink never connects', async () => {
    const client = new WorkerApiClient('http://127.0.0.1:1', 5_000)
    const abort = new AbortController()

    expect(await take(client.events.mux({}, abort.signal), 1)).toEqual([])
  })

  it('closes the socket when the consumer stops reading', async () => {
    const instance = await worker()
    const client = new WorkerApiClient(instance.origin, 5_000)
    const abort = new AbortController()

    const reading = take(client.events.mux({}, abort.signal), 1)
    await instance.awaitDownlinks(1)
    instance.pushMux('r-1', subscribed('a'))
    await reading

    await vi.waitFor(() => { expect(instance.openDownlinks()).toBe(0) })
  })

  it('leaves nothing to close when the consumer aborts before the socket connects', async () => {
    const instance = await worker()
    const client = new WorkerApiClient(instance.origin, 5_000)
    const abort = new AbortController()
    abort.abort()

    expect(await take(client.events.mux({}, abort.signal), 1)).toEqual([])
    await vi.waitFor(() => { expect(instance.openDownlinks()).toBe(0) })
  })
})
