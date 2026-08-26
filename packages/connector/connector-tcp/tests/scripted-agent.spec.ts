/**
 * Tests for the client transport against a scripted peer: handshake answers no
 * real agent produces, notifications for processes the client is not watching,
 * and a socket that dies mid-call.
 */

import { createServer } from 'node:net'
import type { AddressInfo, Server, Socket } from 'node:net'
import { afterEach, describe, expect, it } from 'vitest'
import { CONNECTOR_PROTOCOL_VERSION, encodeFrame } from '@deepseek-ai/dsh-connector/protocol'
import type { ConnectorFrame } from '@deepseek-ai/dsh-connector/protocol'
import { openConnectorTcpLink } from '@deepseek-ai/dsh-connector-tcp'
import type { ConnectorTcpOptions } from '@deepseek-ai/dsh-connector-tcp'

const trash: (() => Promise<void>)[] = []

afterEach(async () => {
  for (const release of trash.splice(0).reverse()) await release()
})

/** A peer whose every answer the test writes by hand. */
interface ScriptedAgent {
  port: number
  /** The connected client socket, once the handshake reached this peer. */
  socket: Promise<Socket>
  send(frame: ConnectorFrame): void
  raw(line: string): void
}

async function scripted(answer: (frame: ConnectorFrame, socket: Socket) => void): Promise<ScriptedAgent> {
  let publish!: (socket: Socket) => void
  const connected = new Promise<Socket>((resolve) => { publish = resolve })
  const sockets: Socket[] = []
  const server: Server = createServer((socket) => {
    sockets.push(socket)
    socket.setEncoding('utf8')
    publish(socket)
    socket.on('error', () => { socket.destroy() })
    socket.on('data', (chunk: string) => {
      for (const line of chunk.split('\n')) {
        if (line.length > 0) answer(JSON.parse(line) as ConnectorFrame, socket)
      }
    })
  })
  await new Promise<void>((resolve) => { server.listen(0, '127.0.0.1', resolve) })
  trash.push(async () => {
    for (const socket of sockets) socket.destroy()
    await new Promise<void>((resolve) => { server.close(() => { resolve() }) })
  })
  return {
    get port(): number {
      return (server.address() as AddressInfo).port
    },
    socket: connected,
    send: (frame) => { void connected.then(socket => socket.write(encodeFrame(frame))) },
    raw: (line) => { void connected.then(socket => socket.write(line)) },
  }
}

function options(port: number): ConnectorTcpOptions {
  return {
    id: 'scripted',
    host: '127.0.0.1',
    port,
    token: 'secret',
    os: 'linux',
    workdir: '/srv/work',
    connectTimeoutMs: 2000,
  }
}

/** A peer that completes the handshake and then does exactly what the test says. */
async function accepting(answer: (frame: ConnectorFrame, socket: Socket) => void = () => {}): Promise<ScriptedAgent> {
  return scripted((frame, socket) => {
    if (frame.t === 'hello') {
      socket.write(encodeFrame({
        t: 'ready',
        protocol: CONNECTOR_PROTOCOL_VERSION,
        os: 'linux',
        workdir: '/srv/work',
      }))
      return
    }
    answer(frame, socket)
  })
}

async function ready(agent: ScriptedAgent): Promise<Awaited<ReturnType<typeof openConnectorTcpLink>>> {
  const link = await openConnectorTcpLink(options(agent.port))
  trash.push(async () => link.close())
  return link
}

describe('handshake answers', () => {
  it('refuses a peer that speaks a different protocol revision', async () => {
    const agent = await scripted((_frame, socket) => {
      socket.write(encodeFrame({ t: 'ready', protocol: 99, os: 'linux', workdir: '/srv/work' }))
    })

    await expect(openConnectorTcpLink(options(agent.port)))
      .rejects.toMatchObject({ code: 'CONNECTOR_PROTOCOL', message: /speaks protocol 99/ })
  })

  it('surfaces the failure a peer answered the handshake with', async () => {
    const agent = await scripted((_frame, socket) => {
      socket.write(encodeFrame({
        t: 'error',
        id: 0,
        error: { kind: 'connector', code: 'CONNECTOR_UNAVAILABLE', message: 'connector token rejected' },
      }))
    })

    await expect(openConnectorTcpLink(options(agent.port)))
      .rejects.toMatchObject({ code: 'CONNECTOR_UNAVAILABLE', message: 'connector token rejected' })
  })

  it('refuses a peer that answers the handshake with something else entirely', async () => {
    const agent = await scripted((_frame, socket) => {
      socket.write(encodeFrame({ t: 'result', id: 1, value: null }))
    })

    await expect(openConnectorTcpLink(options(agent.port)))
      .rejects.toMatchObject({ message: /answered the handshake with a result frame/ })
  })

  it('refuses a peer that hangs up during the handshake', async () => {
    const agent = await scripted((_frame, socket) => { socket.destroy() })

    await expect(openConnectorTcpLink(options(agent.port)))
      .rejects.toMatchObject({ code: 'CONNECTOR_UNAVAILABLE' })
  })
})

describe('frames after the handshake', () => {
  it('drops the link when a peer sends something that is not a frame', async () => {
    const agent = await accepting()
    const link = await ready(agent)
    const pending = link.files.stat('/srv/work', undefined)
    agent.raw('this is not JSON\n')

    await expect(pending).rejects.toMatchObject({ code: 'CONNECTOR_PROTOCOL' })
  })

  it('drops the link when a peer sends a frame no client can answer', async () => {
    const agent = await accepting()
    const link = await ready(agent)
    const pending = link.files.stat('/srv/work', undefined)
    agent.send({ t: 'cancel', id: 1 })

    await expect(pending).rejects.toMatchObject({ message: /sent an unexpected cancel frame/ })
  })

  it('ignores a notification for a process it is not watching', async () => {
    const agent = await accepting((frame, socket) => {
      if (frame.t !== 'call') return
      socket.write(encodeFrame({ t: 'error', id: frame.id, error: { kind: 'plain', message: 'refused' } }))
    })
    const link = await ready(agent)
    agent.send({ t: 'event', handle: 404, kind: 'gone' })
    agent.send({ t: 'result', id: 404, value: null })

    // The link still answers, so neither stray frame disturbed it.
    await expect(link.processes.resolveExecutable('node', undefined, undefined)).rejects.toThrow('refused')
  })

  it('fails every call in flight when the socket dies', async () => {
    const agent = await accepting()
    const link = await ready(agent)
    const pending = link.files.readText('/srv/work/notes.txt', 'notes.txt', undefined)
    ;(await agent.socket).destroy()

    await expect(pending).rejects.toMatchObject({ code: 'CONNECTOR_UNAVAILABLE' })
  })

  it('refuses a new call once the transport is lost', async () => {
    const agent = await accepting()
    const link = await ready(agent)
    ;(await agent.socket).destroy()
    await new Promise<void>((resolve) => { setTimeout(resolve, 20) })

    await expect(link.files.stat('/srv/work', undefined)).rejects.toMatchObject({ code: 'CONNECTOR_UNAVAILABLE' })
  })
})

describe('process notifications', () => {
  /** A peer that publishes every spawn and then replays the given notifications. */
  async function publishing(notifications: readonly ConnectorFrame[]): Promise<ScriptedAgent> {
    const agent = await accepting((frame, socket) => {
      if (frame.t !== 'call' || frame.method !== 'proc.spawn') return
      socket.write(encodeFrame({ t: 'result', id: frame.id, value: { pid: 4242 } }))
      for (const notification of notifications) socket.write(encodeFrame(notification))
    })
    return agent
  }

  const spec = { argv: ['/bin/true'], cwd: '/srv/work', stdin: 'ignore', graceMs: 50 } as const

  /** Record what one observed process reported. */
  function observer(): { events: Parameters<typeof link.processes.spawn>[1]; log: string[]; done: Promise<void> } {
    const log: string[] = []
    let settle!: () => void
    const done = new Promise<void>((resolve) => { settle = resolve })
    return {
      events: {
        data: (stream, base64) => { log.push(`data:${stream}:${base64}`) },
        exit: (outcome) => { log.push(`exit:${String(outcome.exitCode)}:${String(outcome.signal)}`) },
        failed: (message) => { log.push(`failed:${message}`); settle() },
        gone: () => { log.push('gone'); settle() },
      },
      log,
      done,
    }
  }
  let link: Awaited<ReturnType<typeof openConnectorTcpLink>>

  it('defaults the fields a sparse notification omits', async () => {
    const agent = await publishing([
      { t: 'event', handle: 1, kind: 'data' },
      { t: 'event', handle: 1, kind: 'exit' },
      { t: 'event', handle: 1, kind: 'failed' },
    ])
    link = await ready(agent)
    const watcher = observer()

    const handle = await link.processes.spawn(spec, watcher.events)
    await watcher.done

    expect(handle.pid).toBe(4242)
    expect(watcher.log).toEqual(['data:stdout:', 'exit:null:null', 'failed:connector process failed'])
  })

  it('reports a lost transport as tree-exit for a process that already exited', async () => {
    const agent = await publishing([{ t: 'event', handle: 1, kind: 'exit', exitCode: 0, signal: null }])
    link = await ready(agent)
    const watcher = observer()
    await link.processes.spawn(spec, watcher.events)
    await new Promise<void>((resolve) => { setTimeout(resolve, 20) })
    ;(await agent.socket).destroy()

    await watcher.done

    expect(watcher.log).toEqual(['exit:0:null', 'gone'])
  })

  it('stops watching a process whose spawn the peer refused', async () => {
    const agent = await accepting((frame, socket) => {
      if (frame.t !== 'call') return
      socket.write(encodeFrame({
        t: 'error',
        id: frame.id,
        error: { kind: 'plain', message: 'no such executable' },
      }))
    })
    link = await ready(agent)
    const watcher = observer()

    await expect(link.processes.spawn(spec, watcher.events)).rejects.toThrow('no such executable')
    agent.send({ t: 'event', handle: 1, kind: 'gone' })
    await new Promise<void>((resolve) => { setTimeout(resolve, 20) })

    expect(watcher.log).toEqual([])
  })
})
