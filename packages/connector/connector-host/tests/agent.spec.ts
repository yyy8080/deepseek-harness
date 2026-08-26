/**
 * Tests for the `dsh-connector-agent` command line: argument parsing, the
 * token the agent refuses to start without, and the run loop that stops on a
 * termination signal.
 */

import { connect } from 'node:net'
import { resolve } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  CONNECTOR_AGENT_USAGE,
  CONNECTOR_TOKEN_ENV,
  parseConnectorAgentArgs,
  runConnectorAgent,
} from '@deepseek-ai/dsh-connector-host'

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
    )).toEqual({ host: '0.0.0.0', port: 9000, token: 'inline', workdir: resolve('/srv') })
  })

  it('prefers an explicit token over the environment', () => {
    expect(parseConnectorAgentArgs(['--token', 'inline'], { [CONNECTOR_TOKEN_ENV]: 'from-env' }).token).toBe('inline')
  })

  it.each([
    [['positional'], 'unexpected argument "positional"'],
    [['--nope', 'x'], 'unknown option --nope'],
    [['--port'], '--port needs a value'],
    [['--port', 'abc', '--token', 't'], '--port must be an integer between 0 and 65535'],
    [['--port', '70000', '--token', 't'], '--port must be an integer between 0 and 65535'],
    [['--port', '-1', '--token', 't'], '--port must be an integer between 0 and 65535'],
    [['--host', '0.0.0.0'], `set --token or ${CONNECTOR_TOKEN_ENV} to a non-empty shared secret`],
  ])('rejects %j', (argv, detail) => {
    expect(() => parseConnectorAgentArgs(argv, {})).toThrow(`dsh-connector-agent: ${detail}`)
  })
})

describe('running the agent', () => {
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
})
