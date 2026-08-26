/**
 * Fan-in buffer for the gateway's merged event streams: many producers (one
 * per instance, plus the control plane's own) push frames, one consumer
 * iterates them in arrival order.
 * @module @deepseek-ai/dsh-instance-gateway/frame-queue
 */

/** Single-consumer, many-producer frame buffer. */
export class FrameQueue<T> {
  private readonly buffer: T[] = []
  private wake: (() => void) | undefined
  private closed = false

  /**
   * Append one frame, waking a waiting consumer. Pushing after close is a
   * no-op: a producer that loses the race with teardown has no one to deliver
   * to, and the frame it carried is superseded by the stream ending.
   * @param item - the frame to deliver.
   */
  push(item: T): void {
    if (this.closed) return
    this.buffer.push(item)
    this.signal()
  }

  /** End the stream once the already-buffered frames have been consumed. */
  close(): void {
    this.closed = true
    this.signal()
  }

  /**
   * Drain the queue until it closes or the consumer aborts.
   * @param signal - consumer cancellation.
   * @param cleanup - released once iteration ends, however it ends.
   * @returns the frames in arrival order.
   */
  async *iterate(signal: AbortSignal, cleanup: () => void): AsyncGenerator<T> {
    const onAbort = (): void => { this.signal() }
    signal.addEventListener('abort', onAbort)
    try {
      for (;;) {
        // `shift` cannot return undefined while length is positive, and the
        // buffer has one consumer, so no other reader can empty it in between.
        while (this.buffer.length > 0) yield this.buffer.shift() as T
        if (this.closed || signal.aborted) return
        await new Promise<void>((resolve) => { this.wake = resolve })
      }
    } finally {
      signal.removeEventListener('abort', onAbort)
      cleanup()
    }
  }

  private signal(): void {
    const wake = this.wake
    this.wake = undefined
    wake?.()
  }
}
