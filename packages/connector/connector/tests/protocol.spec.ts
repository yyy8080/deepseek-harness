/**
 * Tests for the connector wire protocol: frame encoding, the incremental
 * newline-delimited reader, and the validation every decoded frame passes
 * before either peer acts on it.
 */

import { describe, expect, it } from 'vitest'
import {
  CONNECTOR_MAX_FRAME_BYTES,
  CONNECTOR_PROTOCOL_VERSION,
  ConnectorFrameDecoder,
  decodeFrame,
  encodeFrame,
} from '@deepseek-ai/dsh-connector/protocol'
import type { ConnectorFrame } from '@deepseek-ai/dsh-connector/protocol'

const hello: ConnectorFrame = { t: 'hello', protocol: CONNECTOR_PROTOCOL_VERSION, token: 'secret' }

describe('frame encoding', () => {
  it('terminates every encoded frame with a newline', () => {
    expect(encodeFrame(hello)).toBe('{"t":"hello","protocol":1,"token":"secret"}\n')
  })

  it('round-trips a frame through the decoder', () => {
    expect(new ConnectorFrameDecoder().push(encodeFrame(hello))).toEqual([hello])
  })
})

describe('incremental decoding', () => {
  it('holds a partial frame until its newline arrives', () => {
    const decoder = new ConnectorFrameDecoder()
    const encoded = encodeFrame(hello)

    expect(decoder.push(encoded.slice(0, 10))).toEqual([])
    expect(decoder.push(encoded.slice(10))).toEqual([hello])
  })

  it('returns every frame a single chunk completed, in arrival order', () => {
    const ready: ConnectorFrame = { t: 'ready', protocol: CONNECTOR_PROTOCOL_VERSION, os: 'linux', workdir: '/srv' }

    expect(new ConnectorFrameDecoder().push(`${encodeFrame(hello)}${encodeFrame(ready)}`)).toEqual([hello, ready])
  })

  it('ignores empty lines the peer sent as keepalives', () => {
    expect(new ConnectorFrameDecoder().push('\n\n')).toEqual([])
  })

  it('rejects an unterminated line past the ceiling instead of buffering it', () => {
    const decoder = new ConnectorFrameDecoder(16)

    expect(() => decoder.push('x'.repeat(17))).toThrow(/exceeds the 16-byte limit/)
  })

  it('rejects a terminated line past the ceiling', () => {
    const decoder = new ConnectorFrameDecoder(16)

    expect(() => decoder.push(`${'x'.repeat(17)}\n`)).toThrow(/exceeds the 16-byte limit/)
  })

  it('caps frames at the shared ceiling by default', () => {
    expect(CONNECTOR_MAX_FRAME_BYTES).toBe(64 * 1024 * 1024)
  })
})

describe('frame validation', () => {
  it.each([
    ['{"t":"ready","protocol":1,"os":"linux","workdir":"/srv"}'],
    ['{"t":"call","id":1,"method":"fs.stat","params":["/tmp"]}'],
    ['{"t":"cancel","id":1}'],
    ['{"t":"result","id":1,"value":null}'],
    ['{"t":"error","id":1,"error":{"kind":"plain","message":"boom"}}'],
    ['{"t":"event","handle":1,"kind":"gone"}'],
  ])('accepts %s', (line) => {
    expect(() => decodeFrame(line)).not.toThrow()
  })

  it.each([
    ['not JSON at all', 'is not valid JSON'],
    ['"a string"', 'frame is not an object'],
    ['null', 'frame is not an object'],
    ['{"t":"nope"}', 'unknown frame type "nope"'],
    ['{"t":"hello","protocol":1}', 'frame is missing "token"'],
    ['{"t":"call","id":1,"method":"fs.stat"}', 'call frame has no params array'],
    ['{"t":"call","method":"fs.stat","params":[]}', 'frame is missing "id"'],
    ['{"t":"cancel"}', 'frame is missing "id"'],
    ['{"t":"result"}', 'frame is missing "id"'],
    ['{"t":"error","id":1}', 'frame is missing "error"'],
    ['{"t":"event","handle":1}', 'frame is missing "kind"'],
  ])('rejects %s', (line, detail) => {
    expect(() => decodeFrame(line)).toThrow(new RegExp(detail.replaceAll(/[.*+?^${}()|[\]\\]/g, String.raw`\$&`)))
  })

  it('rejects an over-long line before parsing it', () => {
    expect(() => decodeFrame('{"t":"cancel","id":1}', 4)).toThrow(/exceeds the 4-byte limit/)
  })
})
