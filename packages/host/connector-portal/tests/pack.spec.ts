/**
 * Tests for pack generation: the origin an interpolated script is allowed to
 * carry, the file each target family is saved as, and what the generated
 * scripts actually tell the target to do.
 */

import { describe, expect, it } from 'vitest'
import {
  assertPackOrigin,
  packContentType,
  packFileName,
  packInstallCommand,
  renderConnectorPack,
} from '../src/pack.ts'
import type { ConnectorPackSpec } from '../src/pack.ts'

function spec(overrides: Partial<ConnectorPackSpec> = {}): ConnectorPackSpec {
  return {
    origin: 'https://harness.example.com',
    attachPath: '/connector/attach',
    agentPath: '/connector/agent.mjs',
    token: 'enrollment.secret',
    os: 'linux',
    ...overrides,
  }
}

describe('assertPackOrigin', () => {
  it.each([
    'https://harness.example.com',
    'http://127.0.0.1:3080',
  ])('accepts the canonical origin %s', (origin) => {
    expect(assertPackOrigin(origin)).toBe(origin)
  })

  it.each([
    ['not-a-url', 'is not an absolute origin'],
    ['ftp://harness.example.com', 'must be http: or https:'],
    ['https://harness.example.com/connector', 'carries more than a scheme and authority'],
    ["https://harness.example.com/';curl evil.example.com;'", 'carries more than a scheme and authority'],
  ])('refuses %s', (origin, detail) => {
    expect(() => assertPackOrigin(origin)).toThrow(detail)
  })
})

describe('pack naming', () => {
  it.each([
    ['linux', 'dsh-connector.sh', 'text/x-shellscript; charset=utf-8'],
    ['macos', 'dsh-connector.sh', 'text/x-shellscript; charset=utf-8'],
    ['windows', 'dsh-connector.ps1', 'text/plain; charset=utf-8'],
  ] as const)('saves a %s pack as %s', (os, fileName, contentType) => {
    expect(packFileName(os)).toBe(fileName)
    expect(packContentType(os)).toBe(contentType)
  })
})

describe('renderConnectorPack', () => {
  it('addresses the POSIX script at the deployment and carries its secret', () => {
    const script = renderConnectorPack(spec())

    expect(script.startsWith('#!/usr/bin/env bash\n')).toBe(true)
    expect(script).toContain('DSH_ATTACH_URL="https://harness.example.com/connector/attach"')
    expect(script).toContain('DSH_AGENT_URL="https://harness.example.com/connector/agent.mjs"')
    expect(script).toContain('DSH_CONNECTOR_TOKEN="enrollment.secret"')
    expect(script).toContain('--attach "${DSH_ATTACH_URL}"')
  })

  it('tells the user what running the script grants', () => {
    expect(renderConnectorPack(spec())).toContain('complete read, write, and command')
    expect(renderConnectorPack(spec({ os: 'windows' }))).toContain('complete read, write, and command')
  })

  it('refuses to start on a Node older than the agent supports', () => {
    expect(renderConnectorPack(spec())).toContain('Node 22 or newer is required')
    expect(renderConnectorPack(spec({ os: 'windows' }))).toContain('Node 22 or newer is required')
  })

  it('renders macOS with the same POSIX script as Linux', () => {
    expect(renderConnectorPack(spec({ os: 'macos' }))).toBe(renderConnectorPack(spec({ os: 'linux' })))
  })

  it('addresses the Windows script at the deployment in PowerShell', () => {
    const script = renderConnectorPack(spec({ os: 'windows' }))

    expect(script.startsWith('#Requires -Version 5.1\n')).toBe(true)
    expect(script).toContain("$AttachUrl = 'https://harness.example.com/connector/attach'")
    expect(script).toContain("$Token = 'enrollment.secret'")
    expect(script).toContain('Invoke-WebRequest -UseBasicParsing -Uri $AgentUrl -OutFile $agent')
  })
})

describe('packInstallCommand', () => {
  it.each([
    ['linux', "curl -fsSL 'https://harness.example.com/connector/pack/abc' | bash"],
    ['macos', "curl -fsSL 'https://harness.example.com/connector/pack/abc' | bash"],
    ['windows', "irm 'https://harness.example.com/connector/pack/abc' | iex"],
  ] as const)('writes the %s one-liner', (os, command) => {
    expect(packInstallCommand('https://harness.example.com', '/connector/pack/abc', os)).toBe(command)
  })
})
