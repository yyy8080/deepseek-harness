/**
 * Tests for attach mode's retry loop: what the operator is told about each
 * refused, failed, and served attempt, and that a served connection carries the
 * ordinary protocol even when its first frame rides in the upgrade head.
 */

import { Buffer } from 'node:buffer'
import { createServer } from 'node:http'
import type { IncomingMessage, Server } from 'node:http'
import type { Socket } from 'node:net'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { ConnectorLink } from '@deepseek-ai/dsh-connector'
import { CONNECTOR_PROTOCOL_VERSION, encodeFrame } from '@deepseek-ai/dsh-connector/protocol'
import { createConnectorHost, runConnectorAttachment } from '@deepseek-ai/dsh-connector-host'

/** Attach attempts run back to back; the loop must not idle inside a test. */
const RETRY_DELAY_MS = 1

describe('keeping one machine attached', () => {
  let server: Server
  let origin: string
  let link: ConnectorLink
  const connections = new Set<Socket>()

  beforeEach(async () => {
    // No default request listener: each test installs the answer its attempt
    // must see, and the upgrade tests answer no ordinary request at all.
    server = createServer()
    server.on('connection', (socket: Socket) => {
      connections.add(socket)
      socket.once('close', () => connections.delete(socket))
    })
    await new Promise<void>((ready) => { server.listen(0, '127.0.0.1', ready) })
    origin = `http://127.0.0.1:${String((server.address() as { port: number }).port)}`
    link = await createConnectorHost({ workdir: process.cwd() })
  })

  afterEach(async () => {
    await link.close()
    // An upgraded connection is no longer the http server's to close, so a
    // served attachment would keep `server.close` waiting forever.
    for (const socket of connections) socket.destroy()
    connections.clear()
    await new Promise<void>((closed) => { server.close(() => { closed() }) })
  })

  /**
   * Run the loop until it has reported `attempts` outcomes, then stop it.
   * @param attempts - how many reports to wait for.
   * @param url - the attach endpoint; defaults to this suite's server.
   * @returns every reported line.
   */
  async function report(attempts: number, url = `${origin}/attach`): Promise<string[]> {
    const lines: string[] = []
    const stop = new AbortController()
    const done = runConnectorAttachment({
      url,
      token: 'secret',
      label: 'probe',
      link,
      retryDelayMs: RETRY_DELAY_MS,
      report: (message) => {
        lines.push(message)
        if (lines.length >= attempts) stop.abort()
      },
    }, stop.signal)
    await done
    return lines
  }

  it('states the status and body a deployment refused with', async () => {
    server.on('request', (_req, res) => {
      res.writeHead(403, { 'content-type': 'text/plain' })
      res.end('connector enrollment is unknown or revoked')
    })

    expect((await report(1))[0])
      .toBe(`dsh-connector-agent could not attach to ${origin}/attach (HTTP 403: connector enrollment is unknown or revoked)`)
  })

  it('states the status alone when the refusal carries no body', async () => {
    server.on('request', (_req, res) => { res.writeHead(503); res.end() })

    expect((await report(1))[0]).toContain('(HTTP 503)')
  })

  it('states the failure when the refusal body never arrives', async () => {
    server.on('request', (_req, res) => {
      res.writeHead(500, { 'content-length': '64' })
      // Flushed as its own write, so the agent has a response to read from
      // before the truncation reaches it.
      res.write('truncated', () => { res.socket?.destroy() })
    })

    expect((await report(1))[0]).toMatch(/could not attach .*\(Error/)
  })

  it('states the failure when the endpoint cannot be reached at all', async () => {
    // A TLS dial against this plain-HTTP port also proves the https: scheme
    // selects the https client rather than silently reusing the http one.
    expect((await report(1, `https://127.0.0.1:${String((server.address() as { port: number }).port)}/attach`))[0])
      .toMatch(/could not attach to https:/)
  })

  it('serves the world over an upgrade whose first frame rides in the head', async () => {
    const answered = new Promise<string>((resolve, reject) => {
      server.on('upgrade', (_req: IncomingMessage, socket: Socket) => {
        // One write, so the hello frame reaches the agent as the upgrade head
        // rather than as a read of its own.
        socket.write(
          'HTTP/1.1 101 Switching Protocols\r\nconnection: Upgrade\r\nupgrade: dsh-connector\r\n\r\n'
          + encodeFrame({ t: 'hello', protocol: CONNECTOR_PROTOCOL_VERSION, token: 'secret' }),
        )
        socket.once('data', (chunk: Buffer) => { resolve(chunk.toString('utf8')) })
        socket.once('error', reject)
      })
    })

    // A served attachment never reports again on its own, so this attempt is
    // stopped by the handshake it completes rather than by a report count.
    const lines: string[] = []
    const stop = new AbortController()
    const running = runConnectorAttachment({
      url: `${origin}/attach`,
      token: 'secret',
      label: 'probe',
      link,
      retryDelayMs: RETRY_DELAY_MS,
      report: (message) => { lines.push(message) },
    }, stop.signal)
    await expect(answered).resolves.toContain('"t":"ready"')
    stop.abort()
    await running

    expect(lines).toEqual([`dsh-connector-agent attached to ${origin}/attach as "probe"`])
  })

  it('reports a lost attachment and dials again', async () => {
    server.on('upgrade', (_req: IncomingMessage, socket: Socket) => {
      socket.write('HTTP/1.1 101 Switching Protocols\r\nconnection: Upgrade\r\nupgrade: dsh-connector\r\n\r\n')
      socket.destroy()
    })

    expect(await report(3)).toEqual([
      `dsh-connector-agent attached to ${origin}/attach as "probe"`,
      'dsh-connector-agent lost its attachment',
      `dsh-connector-agent attached to ${origin}/attach as "probe"`,
    ])
  })

  it('stops dialling as soon as it is asked to', async () => {
    const stop = new AbortController()
    stop.abort()

    await expect(runConnectorAttachment({
      url: `${origin}/attach`,
      token: 'secret',
      label: 'probe',
      link,
      retryDelayMs: RETRY_DELAY_MS,
      report: () => { throw new Error('an aborted loop must not dial') },
    }, stop.signal)).resolves.toBeUndefined()
  })
})
