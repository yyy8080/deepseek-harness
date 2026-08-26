/**
 * End-to-end tests of the connector link: a real `dsh-connector-agent` TCP
 * server serving a temporary directory, driven by the client transport that
 * ships beside it.
 */

import { Buffer } from 'node:buffer'
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { connect, createServer } from 'node:net'
import type { AddressInfo, Socket } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { ConnectorLink, ConnectorProcessEvents } from '@deepseek-ai/dsh-connector'
import { CONNECTOR_PROTOCOL_VERSION, encodeFrame } from '@deepseek-ai/dsh-connector/protocol'
import { hostConnectorOs, serveConnector, wireError } from '@deepseek-ai/dsh-connector-host'
import type { ConnectorServer } from '@deepseek-ai/dsh-connector-host'
import { openConnectorTcpLink } from '@deepseek-ai/dsh-connector-tcp'
import type { ConnectorTcpOptions } from '@deepseek-ai/dsh-connector-tcp'

const TOKEN = 'shared-secret'
const trash: (() => Promise<void> | void)[] = []

afterEach(async () => {
  for (const release of trash.splice(0).reverse()) await release()
})

function workdir(): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'dsh-connector-tcp-')))
  trash.push(() => { rmSync(dir, { recursive: true, force: true }) })
  return dir
}

async function agent(dir: string): Promise<ConnectorServer> {
  const server = await serveConnector({ host: '127.0.0.1', port: 0, token: TOKEN, workdir: dir })
  trash.push(async () => server.close())
  return server
}

function options(port: number, dir: string, overrides: Partial<ConnectorTcpOptions> = {}): ConnectorTcpOptions {
  return {
    id: 'target',
    host: '127.0.0.1',
    port,
    token: TOKEN,
    os: hostConnectorOs(),
    workdir: dir,
    connectTimeoutMs: 5000,
    ...overrides,
  }
}

async function linked(dir: string, overrides: Partial<ConnectorTcpOptions> = {}): Promise<ConnectorLink> {
  const server = await agent(dir)
  const link = await openConnectorTcpLink(options(server.port, dir, overrides))
  trash.push(async () => link.close())
  return link
}

/** Collect every notification one spawn produces. */
function recorder(): { events: ConnectorProcessEvents; output: () => string; failures: string[]; done: Promise<void> } {
  const chunks: Buffer[] = []
  const failures: string[] = []
  let settle!: () => void
  const done = new Promise<void>((resolve) => { settle = resolve })
  return {
    events: {
      data: (_stream, base64) => { chunks.push(Buffer.from(base64, 'base64')) },
      exit: () => {},
      failed: (message) => { failures.push(message); settle() },
      gone: () => { settle() },
    },
    output: () => Buffer.concat(chunks).toString('utf8'),
    failures,
    done,
  }
}

describe('handshake', () => {
  it('reports the agent as the machine the declaration named', async () => {
    const dir = workdir()
    const link = await linked(dir)

    expect(link.descriptor).toEqual({ id: 'target', os: hostConnectorOs(), workdir: dir })
  })

  it('refuses a link whose token the agent rejects', async () => {
    const dir = workdir()
    const server = await agent(dir)

    await expect(openConnectorTcpLink(options(server.port, dir, { token: 'wrong' })))
      .rejects.toMatchObject({ code: 'CONNECTOR_UNAVAILABLE', message: 'connector token rejected' })
  })

  it('refuses a link whose declared OS family the agent contradicts', async () => {
    const dir = workdir()
    const server = await agent(dir)
    const other = hostConnectorOs() === 'windows' ? 'linux' : 'windows'

    await expect(openConnectorTcpLink(options(server.port, dir, { os: other })))
      .rejects.toThrow(/is declared as .* but its agent reports/)
  })

  it('refuses a link whose declared workdir the agent contradicts', async () => {
    const dir = workdir()
    const server = await agent(dir)

    await expect(openConnectorTcpLink(options(server.port, dir, { workdir: join(dir, 'elsewhere') })))
      .rejects.toThrow(/is declared with workdir .* but its agent reports/)
  })

  it('fails when nothing is listening', async () => {
    const server = await agent(workdir())
    const port = server.port
    await server.close()

    await expect(openConnectorTcpLink(options(port, workdir()))).rejects.toThrow()
  })

  it('gives up when the peer accepts the socket but never answers', async () => {
    const accepted: Socket[] = []
    const silent = createServer((socket) => { accepted.push(socket) })
    trash.push(async () => {
      for (const socket of accepted) socket.destroy()
      await new Promise<void>((resolve) => { silent.close(() => { resolve() }) })
    })
    await new Promise<void>((resolve) => { silent.listen(0, '127.0.0.1', resolve) })
    const { port } = silent.address() as AddressInfo

    await expect(openConnectorTcpLink({ ...options(port, workdir()), connectTimeoutMs: 20 }))
      .rejects.toThrow(/did not answer within 20ms/)
  })
})

describe('remote filesystem', () => {
  it('resolves, writes, reads, lists, and edits on the target', async () => {
    const dir = workdir()
    const link = await linked(dir)
    const target = await link.files.resolve('notes.txt', undefined, undefined)

    const written = await link.files.writeText({ ...target, content: 'hello\n' }, undefined)
    await expect(link.files.readText(target.targetKey, target.displayPath, undefined)).resolves.toBe('hello\n')
    await expect(link.files.readBytesBase64(target.targetKey, target.displayPath, 64, undefined))
      .resolves.toBe(Buffer.from('hello\n').toString('base64'))
    await expect(link.files.stat(target.targetKey, undefined)).resolves.toMatchObject({ type: 'file' })
    await expect(link.files.lstat('notes.txt', dir, undefined)).resolves.toMatchObject({ type: 'file' })
    await expect(link.files.listDir(dir, dir, undefined)).resolves.toMatchObject([{ name: 'notes.txt' }])
    await expect(link.files.editText(
      {
        ...target,
        edit: { oldString: 'hello', newString: 'bye', replaceAll: false },
        expected: { version: written.version },
      },
      undefined,
    )).resolves.toMatchObject({ after: 'bye\n' })
  })

  it('answers an absent target with undefined rather than a wire null', async () => {
    const dir = workdir()
    const link = await linked(dir)

    await expect(link.files.stat(join(dir, 'absent.txt'), undefined)).resolves.toBeUndefined()
    await expect(link.files.lstat('absent.txt', dir, undefined)).resolves.toBeUndefined()
    await expect(link.files.lstat(join(dir, 'absent.txt'), undefined, undefined)).resolves.toBeUndefined()
  })

  it('rebuilds the target filesystem error class on this side', async () => {
    const dir = workdir()
    const link = await linked(dir)

    await expect(link.files.readText(join(dir, 'absent.txt'), 'absent.txt', undefined))
      .rejects.toMatchObject({ code: 'FS_NOT_FOUND' })
  })

  it('cancels an in-flight call through the agent', async () => {
    const dir = workdir()
    const link = await linked(dir)
    writeFileSync(join(dir, 'notes.txt'), 'hi')
    const controller = new AbortController()
    const reading = link.files.readText(join(dir, 'notes.txt'), 'notes.txt', controller.signal)
    controller.abort()

    await expect(reading).rejects.toMatchObject({ code: 'FS_ABORTED' })
  })

  it('refuses a call once the signal has already fired', async () => {
    const dir = workdir()
    const link = await linked(dir)
    const controller = new AbortController()
    controller.abort()

    await expect(link.files.stat(dir, controller.signal)).rejects.toThrow()
  })
})

describe('remote processes', () => {
  it('resolves an executable on the target', async () => {
    const link = await linked(workdir())

    await expect(link.processes.resolveExecutable(process.execPath, undefined, undefined))
      .resolves.toBe(process.execPath)
  })

  it('rebuilds a plain failure the agent reported', async () => {
    const link = await linked(workdir())

    await expect(link.processes.resolveExecutable('definitely-not-on-path', { PATH: '' }, undefined))
      .rejects.toThrow()
  })

  it('streams a remote process output, exit, and tree-exit', async () => {
    const dir = workdir()
    const link = await linked(dir)
    const observer = recorder()

    const handle = await link.processes.spawn(
      { argv: [process.execPath, '-e', 'process.stdout.write("remote")'], cwd: dir, stdin: 'ignore', graceMs: 100 },
      observer.events,
    )
    await observer.done

    expect(handle.pid).toBeGreaterThan(0)
    expect(observer.output()).toBe('remote')
    expect(observer.failures).toEqual([])
  })

  it('writes to a remote process stdin and closes it', async () => {
    const dir = workdir()
    const link = await linked(dir)
    const observer = recorder()
    const handle = await link.processes.spawn(
      { argv: [process.execPath, '-e', 'process.stdin.pipe(process.stdout)'], cwd: dir, stdin: 'pipe', graceMs: 100 },
      observer.events,
    )

    await handle.write(Buffer.from('over the wire', 'utf8').toString('base64'))
    await handle.closeStdin()
    await observer.done

    expect(observer.output()).toBe('over the wire')
  })

  it('terminates a remote process and swallows a terminate that arrives too late', async () => {
    const dir = workdir()
    const link = await linked(dir)
    const observer = recorder()
    const handle = await link.processes.spawn(
      { argv: [process.execPath, '-e', 'setInterval(() => {}, 1000)'], cwd: dir, stdin: 'ignore', graceMs: 50 },
      observer.events,
    )

    await handle.terminate()
    await observer.done
    await expect(handle.terminate()).resolves.toBeUndefined()
  })

  it('reports a remote spawn that never started', async () => {
    const dir = workdir()
    const link = await linked(dir)
    const observer = recorder()

    await link.processes.spawn(
      { argv: [join(dir, 'not-an-executable')], cwd: dir, stdin: 'ignore', graceMs: 50 },
      observer.events,
    )
    await observer.done

    expect(observer.failures).toHaveLength(1)
  })

  it('fails a live process and every pending call when the link drops', async () => {
    const dir = workdir()
    const server = await agent(dir)
    const link = await openConnectorTcpLink(options(server.port, dir))
    const observer = recorder()
    await link.processes.spawn(
      { argv: [process.execPath, '-e', 'setInterval(() => {}, 1000)'], cwd: dir, stdin: 'ignore', graceMs: 50 },
      observer.events,
    )

    await link.close()
    await observer.done

    expect(observer.failures).toHaveLength(1)
    await expect(link.files.stat(dir, undefined)).rejects.toMatchObject({ code: 'CONNECTOR_UNAVAILABLE' })
  })

  it('abandons the work of a client that leaves mid-call', async () => {
    const dir = workdir()
    const server = await agent(dir)
    const link = await openConnectorTcpLink(options(server.port, dir))
    const observer = recorder()
    const handle = await link.processes.spawn(
      { argv: [process.execPath, '-e', 'setInterval(() => {}, 1000)'], cwd: dir, stdin: 'pipe', graceMs: 50 },
      observer.events,
    )
    // Far larger than any platform's pipe buffer, and the child never reads, so
    // the write cannot finish. The stat behind it is answered only once the
    // agent has dequeued the write, which proves the write is in flight.
    const blocked = handle.write(Buffer.alloc(1024 * 1024, 0x61).toString('base64'))
    await link.files.stat(dir, undefined)

    await link.close()

    await expect(blocked).rejects.toMatchObject({ code: 'CONNECTOR_UNAVAILABLE' })
    // The agent stops cleanly only if it abandoned that call and the tree it
    // started; a leaked tree would hold subprocess disposal open.
    await expect(server.close()).resolves.toBeUndefined()
  })
})

describe('protocol violations', () => {
  /**
   * Speak to the agent directly so a client can send what the transport never
   * would, and read until the answer frame the violation produces.
   */
  async function raw(port: number, lines: readonly string[]): Promise<string> {
    return new Promise<string>((resolve, reject) => {
      const socket = connect({ host: '127.0.0.1', port })
      let received = ''
      socket.setEncoding('utf8')
      socket.on('connect', () => { for (const line of lines) socket.write(line) })
      socket.on('data', (chunk: string) => {
        received += chunk
        if (!received.includes('"t":"error"')) return
        socket.destroy()
        resolve(received)
      })
      socket.on('error', reject)
      socket.on('close', () => { resolve(received) })
    })
  }

  it('refuses a client that speaks a different protocol revision', async () => {
    const server = await agent(workdir())

    await expect(raw(server.port, [encodeFrame({ t: 'hello', protocol: 99, token: TOKEN })]))
      .resolves.toContain('CONNECTOR_PROTOCOL')
  })

  it('refuses a client that skips the handshake', async () => {
    const server = await agent(workdir())

    await expect(raw(server.port, [encodeFrame({ t: 'cancel', id: 1 })]))
      .resolves.toContain('must send hello first')
  })

  it('refuses a frame the agent never accepts', async () => {
    const server = await agent(workdir())
    const hello = encodeFrame({ t: 'hello', protocol: CONNECTOR_PROTOCOL_VERSION, token: TOKEN })

    await expect(raw(server.port, [hello, encodeFrame({ t: 'result', id: 1, value: null })]))
      .resolves.toContain('cannot accept a result frame')
  })

  it('refuses a line that is not a frame at all', async () => {
    const server = await agent(workdir())

    await expect(raw(server.port, ['{"t":"nope"}\n'])).resolves.toContain('unknown frame type')
  })

  it('answers an unknown method with a protocol error', async () => {
    const server = await agent(workdir())
    const hello = encodeFrame({ t: 'hello', protocol: CONNECTOR_PROTOCOL_VERSION, token: TOKEN })
    const call = encodeFrame({ t: 'call', id: 7, method: 'fs.teleport', params: [] })

    await expect(raw(server.port, [hello, call])).resolves.toContain(String.raw`has no method \"fs.teleport\"`)
  })

  it('refuses a second spawn onto a process identifier already in use', async () => {
    const dir = workdir()
    const server = await agent(dir)
    const hello = encodeFrame({ t: 'hello', protocol: CONNECTOR_PROTOCOL_VERSION, token: TOKEN })
    const spec = { argv: [process.execPath, '-e', 'setInterval(() => {}, 1000)'], cwd: dir, stdin: 'ignore', graceMs: 50 }
    const spawn = (id: number): string => encodeFrame({ t: 'call', id, method: 'proc.spawn', params: [spec, 1] })

    await expect(raw(server.port, [hello, spawn(1), spawn(2)])).resolves.toContain('is already live on this connection')
  })

  it('reports a spawn the target refused outright', async () => {
    const dir = workdir()
    const server = await agent(dir)
    const hello = encodeFrame({ t: 'hello', protocol: CONNECTOR_PROTOCOL_VERSION, token: TOKEN })
    const spec = { argv: [], cwd: dir, stdin: 'ignore', graceMs: 50 }
    const call = encodeFrame({ t: 'call', id: 1, method: 'proc.spawn', params: [spec, 1] })

    await expect(raw(server.port, [hello, call])).resolves.toContain('invalid argv')
  })

  it('keeps serving after a client resets its connection', async () => {
    const dir = workdir()
    const server = await agent(dir)
    const rude = connect({ host: '127.0.0.1', port: server.port })
    await new Promise<void>((resolve) => { rude.once('connect', () => { resolve() }) })
    rude.write(encodeFrame({ t: 'hello', protocol: CONNECTOR_PROTOCOL_VERSION, token: TOKEN }))
    rude.resetAndDestroy()

    const link = await openConnectorTcpLink(options(server.port, dir))
    trash.push(async () => link.close())
    await expect(link.files.stat(dir, undefined)).resolves.toMatchObject({ type: 'directory' })
  })

  it.each([
    [encodeFrame({ t: 'call', id: 1, method: 'fs.readText', params: [1, 'x'] }), 'argument 0 must be a string'],
    [encodeFrame({ t: 'call', id: 1, method: 'fs.resolve', params: ['x', 3] }), 'argument 1 must be a string or null'],
    [encodeFrame({ t: 'call', id: 1, method: 'fs.readBytes', params: ['x', 'x', 'big'] }), 'argument 2 must be a number'],
    [encodeFrame({ t: 'call', id: 1, method: 'fs.writeText', params: ['x'] }), 'argument 0 must be an object'],
    [
      encodeFrame({ t: 'call', id: 1, method: 'proc.resolveExecutable', params: ['sh', 'nope'] }),
      'argument 1 must be an object',
    ],
    [encodeFrame({ t: 'call', id: 1, method: 'proc.write', params: [42, 'AA=='] }), 'is not live on this connection'],
    [encodeFrame({ t: 'call', id: 1, method: 'proc.closeStdin', params: [42] }), 'is not live on this connection'],
    [encodeFrame({ t: 'call', id: 1, method: 'proc.terminate', params: [42] }), 'is not live on this connection'],
  ])('rejects a malformed call (%#)', async (call, detail) => {
    const server = await agent(workdir())
    const hello = encodeFrame({ t: 'hello', protocol: CONNECTOR_PROTOCOL_VERSION, token: TOKEN })

    await expect(raw(server.port, [hello, call])).resolves.toContain(detail)
  })
})

describe('serving', () => {
  it('projects a thrown non-error onto the wire as plain text', () => {
    expect(wireError('the target threw a string')).toEqual({ kind: 'plain', message: 'the target threw a string' })
  })

  it('requires a non-empty token', async () => {
    await expect(serveConnector({ host: '127.0.0.1', port: 0, token: '', workdir: workdir() }))
      .rejects.toThrow('connector-host: a non-empty token is required')
  })

  it('releases the execution world when the port cannot be bound', async () => {
    const dir = workdir()
    const taken = await agent(dir)

    await expect(serveConnector({ host: '127.0.0.1', port: taken.port, token: TOKEN, workdir: dir }))
      .rejects.toMatchObject({ code: 'EADDRINUSE' })
  })
})
