import { describe, expect, it } from 'vitest'
import { FrameQueue } from '@deepseek-ai/dsh-instance-gateway'

/** Drain a queue into an array, so a test can assert arrival order. */
async function drain<T>(
  queue: FrameQueue<T>,
  signal: AbortSignal,
  onCleanup: () => void = () => {},
): Promise<T[]> {
  const seen: T[] = []
  for await (const item of queue.iterate(signal, onCleanup)) seen.push(item)
  return seen
}

describe('FrameQueue', () => {
  it('delivers frames buffered before iteration in arrival order', async () => {
    const queue = new FrameQueue<number>()
    queue.push(1)
    queue.push(2)
    queue.close()

    expect(await drain(queue, new AbortController().signal)).toEqual([1, 2])
  })

  it('delivers frames pushed while a consumer is waiting', async () => {
    const queue = new FrameQueue<string>()
    const drained = drain(queue, new AbortController().signal)

    await Promise.resolve()
    queue.push('a')
    await Promise.resolve()
    queue.push('b')
    queue.close()

    expect(await drained).toEqual(['a', 'b'])
  })

  it('ends on abort and still yields what was already buffered', async () => {
    const queue = new FrameQueue<number>()
    const abort = new AbortController()
    queue.push(1)
    abort.abort()

    expect(await drain(queue, abort.signal)).toEqual([1])
  })

  it('wakes a waiting consumer when its signal aborts', async () => {
    const queue = new FrameQueue<number>()
    const abort = new AbortController()
    const drained = drain(queue, abort.signal)

    await Promise.resolve()
    abort.abort()

    expect(await drained).toEqual([])
  })

  it('drops a frame pushed after close rather than delivering it late', async () => {
    const queue = new FrameQueue<number>()
    queue.push(1)
    queue.close()
    queue.push(2)

    expect(await drain(queue, new AbortController().signal)).toEqual([1])
  })

  it('releases the cleanup exactly once, however iteration ends', async () => {
    const closed = new FrameQueue<number>()
    let closedCleanups = 0
    closed.close()
    await drain(closed, new AbortController().signal, () => { closedCleanups += 1 })
    expect(closedCleanups).toBe(1)

    const aborted = new FrameQueue<number>()
    const abort = new AbortController()
    let abortedCleanups = 0
    const drained = drain(aborted, abort.signal, () => { abortedCleanups += 1 })
    await Promise.resolve()
    abort.abort()
    await drained
    expect(abortedCleanups).toBe(1)
  })

  it('releases the cleanup when the consumer breaks out early', async () => {
    const queue = new FrameQueue<number>()
    let cleanups = 0
    queue.push(1)
    queue.push(2)

    for await (const item of queue.iterate(new AbortController().signal, () => { cleanups += 1 })) {
      expect(item).toBe(1)
      break
    }

    expect(cleanups).toBe(1)
  })
})
