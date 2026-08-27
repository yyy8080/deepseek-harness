/**
 * Tests for the assembled portal: the three request paths it registers, the
 * Remote the browser calls, and the round trip a real agent makes from pack
 * download to a registered connector and back off again.
 */

import { Buffer } from 'node:buffer'
import { once } from 'node:events'
import { request as httpRequest } from 'node:http'
import type { IncomingMessage } from 'node:http'
import { connect } from 'node:net'
import type { Socket } from 'node:net'
import { StringDecoder } from 'node:string_decoder'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import ConnectorRegistry from '@deepseek-ai/dsh-connector'
import {
  CONNECTOR_LABEL_HEADER,
  CONNECTOR_PROTOCOL_VERSION,
  CONNECTOR_TOKEN_HEADER,
  CONNECTOR_UPGRADE_PROTOCOL,
  encodeFrame,
} from '@deepseek-ai/dsh-connector/protocol'
import { createConnectorHost, serveConnectorSocket } from '@deepseek-ai/dsh-connector-host'
import WebServer from '@deepseek-ai/dsh-host-webserver'
import { remoteMethods } from '@deepseek-ai/dsh-typert-protocol'
import ConnectorPortal from '../src/index.ts'
import type { Config, ConnectorEnrollmentId } from '../src/index.ts'

/** This package's own directory, served as the target machine's workdir. */
const PACKAGE_DIR = fileURLToPath(new URL('..', import.meta.url))

/**
 * Stand-in for the built agent bundle. The suite must pass on a checkout that
 * has never been built, so the route is pointed at a source-plane file.
 */
const AGENT_PROGRAM = fileURLToPath(new URL('fixtures/agent-program.mjs', import.meta.url))

const contexts: Context[] = []
const stopAgents: Array<() => void | Promise<void>> = []

afterEach(async () => {
  for (const stop of stopAgents.splice(0)) await stop()
  await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.dispose()))
})

interface Harness {
  ctx: Context
  portal: ConnectorPortal
  origin: string
}

/**
 * A preset roster answering `read` for exactly the compositions it is given.
 * Only that one method is reachable from the portal, which asks the roster a
 * single question: what does the configured preset compose?
 * @param compositions - preset id to composition text.
 * @returns the roster double.
 */
function roster(compositions: Readonly<Record<string, string>>): unknown {
  return {
    read: (id: string) => Object.hasOwn(compositions, id)
      ? Promise.resolve(compositions[id] as string)
      : Promise.reject(new Error(`unknown preset ${JSON.stringify(id)}`)),
  }
}

async function harness(config: Config = {}, presets?: Readonly<Record<string, string>>): Promise<Harness> {
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(WebServer, { host: '127.0.0.1', port: 0 })
  await ctx.plugin(ConnectorRegistry, {})
  if (presets !== undefined) ctx.provide('agentPresets', roster(presets) as never)
  await ctx.plugin(ConnectorPortal, { agentProgramPath: AGENT_PROGRAM, ...config })
  const portal = ctx.get('connectorPortal') as ConnectorPortal
  return { ctx, portal, origin: `http://127.0.0.1:${String(ctx.webServer.port)}` }
}

/** Run one agent against the portal's attach endpoint until the test ends. */
async function attachAgent(origin: string, token: string, label: string, workdir: string): Promise<void> {
  const link = await createConnectorHost({ workdir })
  const upgraded = new Promise<Socket>((resolve, reject) => {
    const pending = httpRequest(`${origin}/connector/attach`, {
      method: 'GET',
      headers: {
        'connection': 'Upgrade',
        'upgrade': CONNECTOR_UPGRADE_PROTOCOL,
        [CONNECTOR_TOKEN_HEADER]: token,
        [CONNECTOR_LABEL_HEADER]: label,
      },
    })
    pending.on('upgrade', (_response: IncomingMessage, socket: Socket, head: Buffer) => {
      if (head.length > 0) socket.unshift(head)
      resolve(socket)
    })
    pending.on('response', (response: IncomingMessage) => {
      response.resume()
      reject(new Error(`attach refused: HTTP ${String(response.statusCode)}`))
    })
    pending.on('error', reject)
    pending.end()
  })
  const socket = await upgraded
  const release = serveConnectorSocket(socket, link, token)
  stopAgents.push(async () => { release(); await link.close() })
}

/**
 * Attach over a hand-written upgrade request, which is the only way to control
 * what arrives with it: which headers the agent omits, whether protocol bytes
 * ride along in the upgrade head, and when the first frame is sent.
 * @param origin - the portal origin.
 * @param headers - request header lines, verbatim.
 * @param head - bytes written immediately after the request.
 * @returns the socket and the status line the portal answered with.
 */
async function rawAttach(
  origin: string,
  headers: readonly string[],
  head = '',
): Promise<{ socket: Socket; status: string }> {
  const url = new URL(origin)
  const socket = connect({ host: url.hostname, port: Number(url.port) })
  stopAgents.push(() => { socket.destroy() })
  await once(socket, 'connect')
  socket.write([
    'GET /connector/attach HTTP/1.1',
    `host: ${url.host}`,
    'connection: Upgrade',
    ...headers,
    '',
    '',
  ].join('\r\n') + head)
  // Read by listener rather than by async iteration: ending a `for await` over
  // a socket closes the iterator, which destroys the very connection the
  // upgrade just established.
  const status = await new Promise<string>((resolve, reject) => {
    const text = new StringDecoder('utf8')
    let buffered = ''
    const read = (chunk: Buffer): void => {
      buffered += text.write(chunk)
      const end = buffered.indexOf('\r\n\r\n')
      if (end === -1) return
      socket.off('data', read)
      if (buffered.length > end + 4) socket.unshift(Buffer.from(buffered.slice(end + 4), 'utf8'))
      resolve(buffered.slice(0, buffered.indexOf('\r\n')))
    }
    socket.on('data', read)
    socket.once('close', () => { reject(new Error('the portal closed the connection without answering')) })
  })
  return { socket, status }
}

/** The frame an agent answers the handshake with. */
function readyFrame(workdir: string): string {
  return encodeFrame({ t: 'ready', protocol: CONNECTOR_PROTOCOL_VERSION, os: 'linux', workdir })
}

/** Issue one enrollment and read the token out of its downloaded pack. */
async function enroll(portal: ConnectorPortal, origin: string): Promise<{ id: ConnectorEnrollmentId; token: string }> {
  const ticket = portal.issue({ os: 'linux' })
  const script = (await get(origin, ticket.downloadPath)).body
  return { id: ticket.enrollmentId, token: /DSH_CONNECTOR_TOKEN="([^"]+)"/.exec(script)?.[1] as string }
}

/** Read one socket to end of stream. */
async function collect(socket: Socket): Promise<Buffer[]> {
  const chunks: Buffer[] = []
  for await (const chunk of socket as AsyncIterable<Buffer>) chunks.push(chunk)
  return chunks
}

/** Read one portal route. */
async function get(origin: string, path: string): Promise<{ status: number; body: string; headers: Record<string, string> }> {
  const response = await fetch(`${origin}${path}`)
  return {
    status: response.status,
    body: await response.text(),
    headers: Object.fromEntries(response.headers.entries()),
  }
}

describe('the Remote the browser calls', () => {
  it('publishes issue, list, probe, and revoke under the connectorPortal namespace', async () => {
    const { portal } = await harness()

    expect(portal.typertRemote).toMatchObject({ serviceKey: 'connectorPortal', namespace: 'connectorPortal' })
    expect(remoteMethods(portal)).toEqual([
      { method: 'issue', invocation: { kind: 'direct' } },
      { method: 'list', invocation: { kind: 'direct' } },
      { method: 'probe', invocation: { kind: 'direct' } },
      { method: 'revoke', invocation: { kind: 'direct' } },
    ])
  })

  it('describes the pack a freshly issued enrollment downloads', async () => {
    const { portal } = await harness()

    const ticket = portal.issue({ os: 'windows' })

    expect(ticket).toMatchObject({ os: 'windows', fileName: 'dsh-connector.ps1' })
    expect(ticket.downloadPath).toBe(`/connector/pack/${String(ticket.enrollmentId)}`)
    expect(ticket.installPath).toBe(ticket.downloadPath)
    expect((await portal.list()).enrollments).toEqual([expect.objectContaining({ status: 'issued', os: 'windows' })])
  })

  it('reports a revoke of an enrollment it no longer holds', async () => {
    const { portal } = await harness()

    await expect(portal.revoke({ enrollmentId: 'never-issued' as never })).resolves.toEqual({ revoked: false })
  })
})

describe('whether a conversation can be started on a machine', () => {
  const connectorBacked = '- id: fs\n  name: \'@deepseek-ai/dsh-fs-connector\'\n'

  it('names the composition a connector conversation is built from', async () => {
    const { portal } = await harness({ chatPreset: 'connector' }, { connector: connectorBacked })

    expect((await portal.list()).chat).toEqual({ ready: true, agentPreset: 'connector' })
  })

  it('follows a roster the deployment changes while it runs', async () => {
    const compositions: Record<string, string> = {}
    const { portal } = await harness({ chatPreset: 'connector' }, compositions)
    expect((await portal.list()).chat).toMatchObject({ ready: false, reason: 'preset-missing' })

    compositions.connector = connectorBacked

    expect((await portal.list()).chat).toEqual({ ready: true, agentPreset: 'connector' })
  })

  it.each([
    ['this deployment composes no presets at all', undefined, 'no-preset-roster'],
    ['the configured preset is absent', { standard: connectorBacked }, 'preset-missing'],
    ['the configured preset runs on this machine', { connector: '- id: fs\n  name: \'@deepseek-ai/dsh-fs-local\'\n' }, 'preset-not-connector-backed'],
  ])('refuses, saying %s', async (_case, presets, reason) => {
    const { portal } = await harness({ chatPreset: 'connector' }, presets)

    const { chat } = await portal.list()

    expect(chat).toMatchObject({ ready: false, reason })
    expect((chat as { message: string }).message).not.toBe('')
  })
})

describe('the routes the portal registers', () => {
  it('serves the agent program the packs fetch', async () => {
    const { origin } = await harness()

    const response = await get(origin, '/connector/agent.mjs')

    expect(response.status).toBe(200)
    expect(response.headers['content-type']).toBe('text/javascript; charset=utf-8')
    expect(response.body).toContain('dsh-connector-agent')
  })

  it('renders the pack for the origin the browser reached it on', async () => {
    const { portal, origin } = await harness()
    const ticket = portal.issue({ os: 'linux' })

    const response = await get(origin, ticket.downloadPath)

    expect(response.status).toBe(200)
    expect(response.headers['content-disposition']).toBe('attachment; filename="dsh-connector.sh"')
    expect(response.body).toContain(`DSH_ATTACH_URL="${origin}/connector/attach"`)
    expect((await portal.list()).enrollments[0]).toMatchObject({ status: 'downloaded' })
  })

  it('renders the pack for a configured public origin when a proxy rewrites Host', async () => {
    const { portal, origin } = await harness({ publicOrigin: 'https://harness.example.com' })
    const ticket = portal.issue({ os: 'linux' })

    const response = await get(origin, ticket.downloadPath)

    expect(response.body).toContain('DSH_ATTACH_URL="https://harness.example.com/connector/attach"')
  })

  it.each([
    ['an unknown pack', '/connector/pack/nope', 404],
    ['an unknown portal path', '/connector/whatever', 404],
  ])('answers %s with %i', async (_case, path, status) => {
    const { origin } = await harness()

    expect((await get(origin, path)).status).toBe(status)
  })

  it('refuses a method other than GET or HEAD', async () => {
    const { origin } = await harness()

    const response = await fetch(`${origin}/connector/agent.mjs`, { method: 'POST' })

    expect(response.status).toBe(405)
  })

  it('reports the agent program as unavailable when this build does not carry it', async () => {
    const { origin } = await harness({ agentProgramPath: `${AGENT_PROGRAM}.absent` })

    const response = await get(origin, '/connector/agent.mjs')

    expect(response.status).toBe(503)
    expect(response.body).toContain('not available in this build')
  })

  it('refuses a pack download that states no origin to dial back to', async () => {
    const { portal, origin } = await harness()
    const ticket = portal.issue({ os: 'linux' })
    const url = new URL(origin)
    const socket = connect({ host: url.hostname, port: Number(url.port) })
    await once(socket, 'connect')

    // HTTP/1.0 has no mandatory Host, so this is the one request the portal can
    // receive with nothing to name itself by.
    socket.write(`GET ${ticket.downloadPath} HTTP/1.0\r\n\r\n`)
    const answer = Buffer.concat(await collect(socket)).toString('utf8')

    expect(answer).toContain('400 Bad Request')
    expect(answer).toContain('no usable origin')
  })

  it('refuses a basePath that would not compose into the documented paths', async () => {
    const ctx = new Context()
    contexts.push(ctx)
    await ctx.plugin(WebServer, { host: '127.0.0.1', port: 0 })
    await ctx.plugin(ConnectorRegistry, {})

    await expect(ctx.plugin(ConnectorPortal, { basePath: 'connector/' }))
      .rejects.toThrow('must be an absolute path without a trailing slash')
  })
})

describe('an agent attaching', () => {
  it('registers the machine it serves and reports it as attached', async () => {
    const { ctx, portal, origin } = await harness()
    const ticket = portal.issue({ os: 'linux' })
    const script = (await get(origin, ticket.downloadPath)).body
    const token = /DSH_CONNECTOR_TOKEN="([^"]+)"/.exec(script)?.[1] as string
    const attached = new Promise<void>((resolve) => { ctx.once('connector-portal/attached', () => { resolve() }) })

    await attachAgent(origin, token, 'build-box', process.cwd())
    await attached

    expect((await portal.list()).enrollments[0]).toMatchObject({
      status: 'attached',
      label: 'build-box',
      connectorId: String(ticket.enrollmentId),
    })
    expect(ctx.connectors.list().map(descriptor => String(descriptor.id)))
      .toEqual([String(ticket.enrollmentId)])
  })

  it('serves the target machine\'s files through the registered connector', async () => {
    const { ctx, portal, origin } = await harness()
    const ticket = portal.issue({ os: 'linux' })
    const script = (await get(origin, ticket.downloadPath)).body
    const token = /DSH_CONNECTOR_TOKEN="([^"]+)"/.exec(script)?.[1] as string
    const attached = new Promise<void>((resolve) => { ctx.once('connector-portal/attached', () => { resolve() }) })
    await attachAgent(origin, token, 'build-box', PACKAGE_DIR)
    await attached

    // The registry resolves a connector from the calling session's binding, so
    // reading through it is what proves the attachment is usable by a
    // conversation rather than merely present in the ledger.
    const session = {
      events: [{ type: 'connector/bound', data: { connectorId: ticket.enrollmentId } }],
    } as never
    const link = await ctx.connectors.link({ session })
    const target = await link.files.resolve('package.json', undefined, undefined)

    expect(await link.files.readText(target.targetKey, target.displayPath, undefined))
      .toContain('@deepseek-ai/dsh-host-connector-portal')
  })

  it('drops the connector when its enrollment is revoked', async () => {
    const { ctx, portal, origin } = await harness()
    const ticket = portal.issue({ os: 'linux' })
    const script = (await get(origin, ticket.downloadPath)).body
    const token = /DSH_CONNECTOR_TOKEN="([^"]+)"/.exec(script)?.[1] as string
    const attached = new Promise<void>((resolve) => { ctx.once('connector-portal/attached', () => { resolve() }) })
    await attachAgent(origin, token, 'build-box', process.cwd())
    await attached

    await expect(portal.revoke({ enrollmentId: ticket.enrollmentId })).resolves.toEqual({ revoked: true })

    expect((await portal.list()).enrollments).toEqual([])
    expect(ctx.connectors.list()).toEqual([])
  })

  it.each([
    ['an unknown token', 'nope.secret', 403],
    ['an empty token', '', 403],
  ])('refuses %s with %i', async (_case, token, status) => {
    const { origin } = await harness()

    await expect(attachAgent(origin, token, 'rogue', process.cwd()))
      .rejects.toThrow(`attach refused: HTTP ${String(status)}`)
  })

  it('refuses a machine beyond the configured limit', async () => {
    const { ctx, portal, origin } = await harness({ maxConnectors: 1 })
    const first = portal.issue({ os: 'linux' })
    const firstToken = /DSH_CONNECTOR_TOKEN="([^"]+)"/
      .exec((await get(origin, first.downloadPath)).body)?.[1] as string
    const attached = new Promise<void>((resolve) => { ctx.once('connector-portal/attached', () => { resolve() }) })
    await attachAgent(origin, firstToken, 'first', process.cwd())
    await attached
    const second = portal.issue({ os: 'linux' })
    const secondToken = /DSH_CONNECTOR_TOKEN="([^"]+)"/
      .exec((await get(origin, second.downloadPath)).body)?.[1] as string

    await expect(attachAgent(origin, secondToken, 'second', process.cwd()))
      .rejects.toThrow('attach refused: HTTP 503')
  })

  it('refuses an agent that presents no token at all', async () => {
    const { origin } = await harness()

    const { status } = await rawAttach(origin, [`upgrade: ${CONNECTOR_UPGRADE_PROTOCOL}`])

    expect(status).toContain('403 Forbidden')
  })

  it('adopts an agent that names no machine and sends its first frame with the upgrade', async () => {
    const { ctx, portal, origin } = await harness()
    const { token } = await enroll(portal, origin)
    const attached = new Promise<void>((resolve) => { ctx.once('connector-portal/attached', () => { resolve() }) })

    // No label header, and the `ready` frame rides in the upgrade head rather
    // than arriving as its own read.
    await rawAttach(
      origin,
      [`upgrade: ${CONNECTOR_UPGRADE_PROTOCOL}`, `${CONNECTOR_TOKEN_HEADER}: ${token}`],
      readyFrame('/srv/eager'),
    )
    await attached

    expect((await portal.list()).enrollments[0]).toMatchObject({ label: '/srv/eager', workdir: '/srv/eager' })
  })

  it('drops an agent that answers the handshake with something other than ready', async () => {
    const { ctx, portal, origin } = await harness()
    const { token } = await enroll(portal, origin)

    const { socket } = await rawAttach(
      origin,
      [`upgrade: ${CONNECTOR_UPGRADE_PROTOCOL}`, `${CONNECTOR_TOKEN_HEADER}: ${token}`],
      encodeFrame({ t: 'result', id: 1, value: null }),
    )
    await once(socket, 'close')

    expect((await portal.list()).enrollments[0]).toMatchObject({ status: 'downloaded' })
    expect(ctx.connectors.list()).toEqual([])
  })

  it('discards an adoption whose enrollment was revoked while it shook hands', async () => {
    const { ctx, portal, origin } = await harness()
    const { id, token } = await enroll(portal, origin)
    const { socket } = await rawAttach(
      origin,
      [`upgrade: ${CONNECTOR_UPGRADE_PROTOCOL}`, `${CONNECTOR_TOKEN_HEADER}: ${token}`],
    )

    await portal.revoke({ enrollmentId: id })
    socket.write(readyFrame('/srv/late'))
    await once(socket, 'close')

    expect((await portal.list()).enrollments).toEqual([])
    expect(ctx.connectors.list()).toEqual([])
  })

  it('discards an adoption a later dial of the same machine overtook', async () => {
    const { ctx, portal, origin } = await harness()
    const { token } = await enroll(portal, origin)
    const header = [`upgrade: ${CONNECTOR_UPGRADE_PROTOCOL}`, `${CONNECTOR_TOKEN_HEADER}: ${token}`]
    const slow = await rawAttach(origin, [...header, `${CONNECTOR_LABEL_HEADER}: slow`])
    const fast = await rawAttach(origin, [...header, `${CONNECTOR_LABEL_HEADER}: fast`])
    const attached = new Promise<void>((resolve) => { ctx.once('connector-portal/attached', () => { resolve() }) })

    // The later dial finishes first, so the earlier one must not take the
    // enrollment's slot — or its connector id — away from it afterwards.
    fast.socket.write(readyFrame('/srv/fast'))
    await attached
    slow.socket.write(readyFrame('/srv/slow'))
    await once(slow.socket, 'close')

    expect((await portal.list()).enrollments[0]).toMatchObject({ status: 'attached', label: 'fast' })
    expect(ctx.connectors.list().map(descriptor => descriptor.workdir)).toEqual(['/srv/fast'])
  })

  it('answers a liveness probe with the round trip the target completed', async () => {
    const { ctx, portal, origin } = await harness()
    const { id, token } = await enroll(portal, origin)
    const attached = new Promise<void>((resolve) => { ctx.once('connector-portal/attached', () => { resolve() }) })
    await attachAgent(origin, token, 'build-box', PACKAGE_DIR)
    await attached

    const report = await portal.probe({ enrollmentId: id })

    expect(report).toMatchObject({ alive: true, enrollmentId: id, workdirIsDirectory: true })
    // The target resolves its own workdir, so the answer is its canonical path
    // rather than the string the handshake happened to carry.
    expect((report as { resolvedWorkdir: string }).resolvedWorkdir).toContain('connector-portal')
    expect((report as { latencyMs: number }).latencyMs).toBeGreaterThanOrEqual(0)
  })

  it('reports a live link whose working directory is gone', async () => {
    const { ctx, portal, origin } = await harness()
    const { id, token } = await enroll(portal, origin)
    const attached = new Promise<void>((resolve) => { ctx.once('connector-portal/attached', () => { resolve() }) })
    await attachAgent(origin, token, 'build-box', `${PACKAGE_DIR}never-existed`)
    await attached

    // The link answered, which is what the probe measures; the directory it
    // answered about is a separate fact the operator still needs.
    expect(await portal.probe({ enrollmentId: id }))
      .toMatchObject({ alive: true, workdirIsDirectory: false })
  })

  it('reports a target that holds the connection but stopped answering', async () => {
    const { ctx, portal, origin } = await harness({ probeTimeoutMs: 250 })
    const { id, token } = await enroll(portal, origin)
    const attached = new Promise<void>((resolve) => { ctx.once('connector-portal/attached', () => { resolve() }) })
    // A raw socket completes the handshake and then serves nothing, which is
    // what a suspended or wedged target looks like from this side.
    await rawAttach(
      origin,
      [`upgrade: ${CONNECTOR_UPGRADE_PROTOCOL}`, `${CONNECTOR_TOKEN_HEADER}: ${token}`],
      readyFrame('/srv/silent'),
    )
    await attached

    const report = await portal.probe({ enrollmentId: id })

    expect(report).toMatchObject({ alive: false, failure: 'link-failed' })
    expect((report as { message: string }).message).toContain('re-run the connector pack')
    // The ledger still reads "attached", which is exactly why the probe exists.
    expect((await portal.list()).enrollments[0]).toMatchObject({ status: 'attached' })
  })

  it.each([
    ['an enrollment it never issued', undefined, 'unknown-enrollment'],
    ['an enrollment no agent has dialled in for', 'issued', 'not-attached'],
  ])('refuses to call %s alive', async (_case, state, failure) => {
    const { portal } = await harness()
    const enrollmentId = state === 'issued'
      ? portal.issue({ os: 'linux' }).enrollmentId
      : 'never-issued' as ConnectorEnrollmentId

    expect(await portal.probe({ enrollmentId })).toMatchObject({ alive: false, enrollmentId, failure })
  })

  it('drops a connection that names a protocol other than the connector upgrade', async () => {
    const { origin } = await harness()

    await expect(new Promise<void>((resolve, reject) => {
      const pending = httpRequest(`${origin}/connector/attach`, {
        method: 'GET',
        headers: { connection: 'Upgrade', upgrade: 'websocket' },
      })
      pending.on('upgrade', () => { reject(new Error('the portal answered a foreign upgrade')) })
      pending.on('response', () => { reject(new Error('the portal answered with a response')) })
      pending.on('error', () => { resolve() })
      pending.end()
    })).resolves.toBeUndefined()
  })
})
