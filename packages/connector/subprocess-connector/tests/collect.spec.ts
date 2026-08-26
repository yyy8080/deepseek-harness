/**
 * Tests for client-side bounded collection: the retained tail, the offsets a
 * reader sees, and the loss it reports once bytes slide out of the window.
 */

import { Buffer } from 'node:buffer'
import { describe, expect, it } from 'vitest'
import { ConnectorOutputCollector } from '@deepseek-ai/dsh-subprocess-connector'

describe('bounded collection', () => {
  it('retains everything that fits and reads from any offset', () => {
    const collector = new ConnectorOutputCollector(16)
    collector.append(Buffer.from('hello '))
    collector.append(Buffer.from('world'))

    expect(collector.truncated).toBe(false)
    expect(collector.readFrom(0)).toEqual({ text: 'hello world', nextOffset: 11, lossy: false })
    expect(collector.readFrom(6)).toEqual({ text: 'world', nextOffset: 11, lossy: false })
    expect(collector.readFrom(11)).toEqual({ text: '', nextOffset: 11, lossy: false })
  })

  it('clamps a read past the end of the stream', () => {
    const collector = new ConnectorOutputCollector(16)
    collector.append(Buffer.from('abc'))

    expect(collector.readFrom(99)).toEqual({ text: '', nextOffset: 3, lossy: false })
  })

  it('drops the head once the window overflows and reports the loss', () => {
    const collector = new ConnectorOutputCollector(4)
    collector.append(Buffer.from('abcdefg'))

    expect(collector.truncated).toBe(true)
    expect(collector.readFrom(0)).toEqual({ text: 'defg', nextOffset: 7, lossy: true })
    expect(collector.readFrom(4)).toEqual({ text: 'efg', nextOffset: 7, lossy: false })
  })

  it('keeps whole-stream offsets across several overflowing appends', () => {
    const collector = new ConnectorOutputCollector(3)
    collector.append(Buffer.from('abc'))
    collector.append(Buffer.from('de'))

    expect(collector.readFrom(2)).toEqual({ text: 'cde', nextOffset: 5, lossy: false })
  })
})
