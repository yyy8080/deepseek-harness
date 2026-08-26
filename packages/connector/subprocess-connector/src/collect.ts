/**
 * Client-side bounded collection for one connector-backed output stream. The
 * subprocess seam's readers are synchronous and offset-based, so the bytes have
 * to be retained on this side of the link rather than read back from the agent
 * per call.
 * @module @deepseek-ai/dsh-subprocess-connector/collect
 */

import { Buffer } from 'node:buffer'
import type { SubprocessOutputRead, SubprocessOutputReader } from '@deepseek-ai/dsh-subprocess'

/**
 * A tail-keeping collector over a whole-stream byte coordinate space. Reads
 * from an offset that has slid out of the retained window report `lossy` and
 * return whatever tail remains.
 */
export class ConnectorOutputCollector implements SubprocessOutputReader {
  private tail = Buffer.alloc(0)
  /** Whole-stream byte offset of the first byte still retained in `tail`. */
  private base = 0

  constructor(private readonly maxBytes: number) {}

  /**
   * Retain one delivered chunk, dropping the head when the window overflows.
   * @param chunk - the newly delivered bytes.
   */
  append(chunk: Buffer): void {
    const joined = Buffer.concat([this.tail, chunk])
    if (joined.length <= this.maxBytes) {
      this.tail = joined
      return
    }
    const dropped = joined.length - this.maxBytes
    this.tail = joined.subarray(dropped)
    this.base += dropped
  }

  /** Whether any byte has been dropped from the retained window. */
  get truncated(): boolean {
    return this.base > 0
  }

  readFrom(fromByte: number): SubprocessOutputRead {
    if (fromByte < this.base) {
      return { text: this.tail.toString('utf8'), nextOffset: this.base + this.tail.length, lossy: true }
    }
    const start = Math.min(fromByte - this.base, this.tail.length)
    return {
      text: this.tail.subarray(start).toString('utf8'),
      nextOffset: this.base + this.tail.length,
      lossy: false,
    }
  }
}
