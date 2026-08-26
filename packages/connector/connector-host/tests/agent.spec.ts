/**
 * Tests for the `dsh-connector-agent` command line: argument parsing, the
 * token the agent refuses to start without, and the run loop that stops on a
 * termination signal.
 */

import { createServer } from 'node:http'
import type { Server } from 'node:http'
import { connect } from 'node:net'
import { hostname } from 'node:os'
import { resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  CONNECTOR_AGENT_USAGE,
  CONNECTOR_ATTACH_ENV,
  CONNECTOR_TOKEN_ENV,
  parseConnectorAgentArgs,
  runConnectorAgent,
} from '@deepseek-ai/dsh-connector-host'
import { CONNECTOR_LABEL_HEADER, CONNECTOR_TOKEN_HEADER } from '@deepseek-ai/dsh-connector/protocol'
import { openConnectorLinkOverSocket } from '@deepseek-ai/dsh-connector-tcp'

const trash: (() => void)[] = []

afterEach(() => {
  for (const release of trash.splice(0)) release()
  vi.restoreAllMocks()
})

/** Capture what the agent prints while it runs. */
function captureStdout(): { lines: string[] } {
  const lines: string[] = []
  const original = process.stdout.write.bind(process.stdout)
  process.stdout.write = (chunk: string) => { lines.push(chunk); return true }
  trash.push(() => { process.stdout.write = original })
  return { lines }
}

describe('argument parsing', () => {
  it('defaults to loopback, the standard port, and the process cwd', () => {
    expect(parseConnectorAgentArgs([], { [CONNECTOR_TOKEN_ENV]: 'secret' })).toEqual({
      mode: 'listen',
      host: '127.0.0.1',
      port: 8765,
      token: 'secret',
      workdir: resolve(process.cwd()),
    })
  })

  it('takes every option from the command line', () => {
    expect(parseConnectorAgentArgs(
      ['--host', '0.0.0.0', '--port', '9000', '--workdir', '/srv/work/..', '--token', 'inline'],
      {},
    )).toEqual({ mode: 'listen', host: '0.0.0.0', port: 9000, token: 'inline', workdir: resolve('/srv') })
  })

  it('prefers an explicit token over the environment', () => {
    expect(parseConnectorAgentArgs(['--token', 'inline'], { [CONNECTOR_TOKEN_ENV]: 'from-env' }).token).toBe('inline')
  })

  it('switches to attach mode and names the machine after the host', () => {
    expect(parseConnectorAgentArgs(
      ['--attach', 'https://harness.example.com/connector/attach', '--workdir', '/srv'],
      { [CONNECTOR_TOKEN_ENV]: 'secret' },
    )).toEqual({
      mode: 'attach',
      url: 'https://harness.example.com/connector/attach',
      label: hostname(),
      token: 'secret',
      workdir: resolve('/srv'),
    })
  })

  it('reads the attach endpoint from the environment and takes an explicit label', () => {
    expect(parseConnectorAgentArgs(['--label', 'build-box'], {
      [CONNECTOR_TOKEN_ENV]: 'secret',
      [CONNECTOR_ATTACH_ENV]: 'http://127.0.0.1:3080/connector/attach',
    })).toMatchObject({ mode: 'attach', url: 'http://127.0.0.1:3080/connector/attach', label: 'build-box' })
  })

  it.each([
    [['positional'], 'unexpected argument "positional"'],
    [['--nope', 'x'], 'unknown option --nope'],
    [['--port'], '--port needs a value'],
    [['--port', 'abc', '--token', 't'], '--port must be an integer between 0 and 65535'],
    [['--port', '70000', '--token', 't'], '--port must be an integer between 0 and 65535'],
    [['--port', '-1', '--token', 't'], '--port must be an integer between 0 and 65535'],
    [['--host', '0.0.0.0'], `set --token or ${CONNECTOR_TOKEN_ENV} to a non-empty shared secret`],
    [
      ['--token', 't', '--attach', 'http://h/attach', '--host', '0.0.0.0'],
      '--host is a listen-mode option and cannot be combined with --attach',
    ],
    [
      ['--token', 't', '--attach', 'http://h/attach', '--port', '9000'],
      '--port is a listen-mode option and cannot be combined with --attach',
    ],
    [['--token', 't', '--label', 'box'], '--label names the machine to a deployment and requires --attach'],
    [['--token', 't', '--attach', 'not a url'], '--attach "not a url" is not an absolute URL'],
    [['--token', 't', '--attach', 'ftp://h/attach'], '--attach must name an http: or https: endpoint, not ftp:'],
  ])('rejects %j', (argv, detail) => {
    expect(() => parseConnectorAgentArgs(argv, {})).toThrow(`dsh-connector-agent: ${detail}`)
  })
})

describe('running the agent', () => {
  let server: Server
  let port: number

  beforeEach(async () => {
    server = createServer((_req, res) => { res.writeHead(404); res.end() })
    await new Promise<void>((ready) => { server.listen(0, '127.0.0.1', ready) })
    port = (server.address() as { port: number }).port
  })

  afterEach(async () => {
    await new Promise<void>((closed) => { server.close(() => { closed() }) })
  })

  it('prints usage and starts nothing for --help', async () => {
    const stdout = captureStdout()

    await runConnectorAgent(['--help'])

    expect(stdout.lines.join('')).toBe(CONNECTOR_AGENT_USAGE)
  })

  it('listens until a termination signal arrives', async () => {
    const stdout = captureStdout()
    vi.stubEnv(CONNECTOR_TOKEN_ENV, 'secret')

    const running = runConnectorAgent(['--port', '0', '--workdir', process.cwd()])
    await vi.waitUntil(() => stdout.lines.length > 0)
    const port = Number(/:(\d+) /.exec(stdout.lines.join('') ?? '')?.[1])
    await new Promise<void>((done, fail) => {
      const socket = connect({ host: '127.0.0.1', port })
      socket.on('connect', () => { socket.destroy(); done() })
      socket.on('error', fail)
    })

    process.emit('SIGTERM')
    await running

    expect(stdout.lines.join('')).toContain('dsh-connector-agent listening on 127.0.0.1:')
  })

  it('dials the attach endpoint and serves the world over the upgraded connection', async () => {
    const stdout = captureStdout()
    vi.stubEnv(CONNECTOR_TOKEN_ENV, 'attach-secret')
    const attached = new Promise<{ label: string | undefined; workdir: string }>((resolve_, reject) => {
      server.on('upgrade', (req, socket, head) => {
        expect(req.headers[CONNECTOR_TOKEN_HEADER]).toBe('attach-secret')
        socket.write('HTTP/1.1 101 Switching Protocols\r\nconnection: Upgrade\r\nupgrade: dsh-connector\r\n\r\n')
        if (head.length > 0) socket.unshift(head)
        openConnectorLinkOverSocket(socket as never, {
          id: 'probe',
          token: 'attach-secret',
          handshakeTimeoutMs: 5000,
        }).then(
          async (link) => {
            const workdir = link.descriptor.workdir
            await link.close()
            resolve_({ label: req.headers[CONNECTOR_LABEL_HEADER] as string | undefined, workdir })
          },
          reject,
        )
      })
    })

    const running = runConnectorAgent([
      '--attach', `http://127.0.0.1:${String(port)}/attach`,
      '--label', 'probe-target',
      '--workdir', process.cwd(),
    ])
    await expect(attached).resolves.toEqual({ label: 'probe-target', workdir: resolve(process.cwd()) })

    process.emit('SIGTERM')
    await running

    expect(stdout.lines.join('')).toContain('dsh-connector-agent attached to')
  })
})
