/**
 * The downloadable connector pack: one self-contained start script per target
 * family, generated for the deployment that serves it.
 *
 * A pack is a script rather than an archive because the target only ever needs
 * three facts — where to dial, which secret to present, and where to fetch the
 * agent — and a script carries them in the one file a user can run directly.
 * The script fetches the bundled agent from the same deployment, so the target
 * needs Node and nothing else: no npm registry, no build step, no unpacking.
 *
 * Every value interpolated into a script is either generated here (the secret)
 * or an origin this module already validated, because the product of this
 * module is code the target executes.
 *
 * @module @deepseek-ai/dsh-host-connector-portal/pack
 */

import type { ConnectorPackOs } from './types.ts'

/** Where a generated script reaches its deployment and how it identifies itself. */
export interface ConnectorPackSpec {
  /** Absolute origin of the deployment, scheme and authority only. */
  origin: string
  /** Origin-relative path of the attach upgrade endpoint. */
  attachPath: string
  /** Origin-relative path serving the bundled agent program. */
  agentPath: string
  /** Enrollment secret the agent presents when it dials in. */
  token: string
  /** Target family the script runs on. */
  os: ConnectorPackOs
}

/** Lowest Node major the connector agent runs on. */
const MINIMUM_NODE_MAJOR = 22

/**
 * Refuse an origin that is not exactly a scheme plus an authority. The result
 * is interpolated into a shell script, so anything that could carry a quote, a
 * path, or a query is rejected rather than escaped.
 * @param value - the candidate origin.
 * @returns the canonical origin.
 */
export function assertPackOrigin(value: string): string {
  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw new Error(`connector-portal: ${JSON.stringify(value)} is not an absolute origin`)
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error(`connector-portal: origin ${JSON.stringify(value)} must be http: or https:`)
  }
  if (url.origin !== value) {
    throw new Error(`connector-portal: ${JSON.stringify(value)} carries more than a scheme and authority`)
  }
  return url.origin
}

/** File name a target saves one pack under. */
export function packFileName(os: ConnectorPackOs): string {
  return os === 'windows' ? 'dsh-connector.ps1' : 'dsh-connector.sh'
}

/** Media type a pack download is served with. */
export function packContentType(os: ConnectorPackOs): string {
  return os === 'windows' ? 'text/plain; charset=utf-8' : 'text/x-shellscript; charset=utf-8'
}

/** The POSIX start script: fetch the agent once, then keep it attached. */
function posixPack(spec: ConnectorPackSpec): string {
  return `#!/usr/bin/env bash
# DeepSeek Harness connector — generated for ${spec.origin}
#
# Running this script gives that deployment complete read, write, and command
# access to this machine, under your user account, for as long as the agent
# runs. Stop it with Ctrl-C. The token below is this machine's credential for
# that deployment; treat the file as a secret and delete it when you are done.
set -euo pipefail

DSH_ATTACH_URL="${spec.origin}${spec.attachPath}"
DSH_AGENT_URL="${spec.origin}${spec.agentPath}"
DSH_CONNECTOR_TOKEN="${spec.token}"
DSH_CONNECTOR_HOME="\${DSH_CONNECTOR_HOME:-\${HOME}/.dsh-connector}"
DSH_CONNECTOR_WORKDIR="\${DSH_CONNECTOR_WORKDIR:-\${PWD}}"
DSH_CONNECTOR_LABEL="\${DSH_CONNECTOR_LABEL:-$(hostname 2>/dev/null || echo target)}"

if ! command -v node >/dev/null 2>&1; then
  echo "dsh-connector: Node ${String(MINIMUM_NODE_MAJOR)} or newer is required and 'node' is not on PATH." >&2
  exit 1
fi
node_major="$(node -p 'process.versions.node.split(".")[0]')"
if [ "\${node_major}" -lt ${String(MINIMUM_NODE_MAJOR)} ]; then
  echo "dsh-connector: Node ${String(MINIMUM_NODE_MAJOR)} or newer is required, found $(node -v)." >&2
  exit 1
fi

mkdir -p "\${DSH_CONNECTOR_HOME}"
agent="\${DSH_CONNECTOR_HOME}/dsh-connector-agent.mjs"
if command -v curl >/dev/null 2>&1; then
  curl -fsSL "\${DSH_AGENT_URL}" -o "\${agent}"
elif command -v wget >/dev/null 2>&1; then
  wget -qO "\${agent}" "\${DSH_AGENT_URL}"
else
  echo "dsh-connector: neither curl nor wget is available to fetch the agent." >&2
  exit 1
fi

echo "dsh-connector: serving \${DSH_CONNECTOR_WORKDIR} to \${DSH_ATTACH_URL}"
export DSH_CONNECTOR_TOKEN
exec node "\${agent}" \\
  --attach "\${DSH_ATTACH_URL}" \\
  --label "\${DSH_CONNECTOR_LABEL}" \\
  --workdir "\${DSH_CONNECTOR_WORKDIR}"
`
}

/** The Windows start script: the same three steps in PowerShell. */
function windowsPack(spec: ConnectorPackSpec): string {
  return `#Requires -Version 5.1
# DeepSeek Harness connector — generated for ${spec.origin}
#
# Running this script gives that deployment complete read, write, and command
# access to this machine, under your user account, for as long as the agent
# runs. Stop it with Ctrl-C. The token below is this machine's credential for
# that deployment; treat the file as a secret and delete it when you are done.
$ErrorActionPreference = 'Stop'

$AttachUrl = '${spec.origin}${spec.attachPath}'
$AgentUrl = '${spec.origin}${spec.agentPath}'
$Token = '${spec.token}'
$Home_ = if ($env:DSH_CONNECTOR_HOME) { $env:DSH_CONNECTOR_HOME } else { Join-Path $env:USERPROFILE '.dsh-connector' }
$Workdir = if ($env:DSH_CONNECTOR_WORKDIR) { $env:DSH_CONNECTOR_WORKDIR } else { (Get-Location).Path }
$Label = if ($env:DSH_CONNECTOR_LABEL) { $env:DSH_CONNECTOR_LABEL } else { $env:COMPUTERNAME }

$node = Get-Command node -ErrorAction SilentlyContinue
if (-not $node) {
  Write-Error "dsh-connector: Node ${String(MINIMUM_NODE_MAJOR)} or newer is required and 'node' is not on PATH."
  exit 1
}
$major = [int](& node -p 'process.versions.node.split(".")[0]')
if ($major -lt ${String(MINIMUM_NODE_MAJOR)}) {
  Write-Error "dsh-connector: Node ${String(MINIMUM_NODE_MAJOR)} or newer is required, found $(& node -v)."
  exit 1
}

New-Item -ItemType Directory -Force -Path $Home_ | Out-Null
$agent = Join-Path $Home_ 'dsh-connector-agent.mjs'
Invoke-WebRequest -UseBasicParsing -Uri $AgentUrl -OutFile $agent

Write-Host "dsh-connector: serving $Workdir to $AttachUrl"
$env:DSH_CONNECTOR_TOKEN = $Token
& node $agent --attach $AttachUrl --label $Label --workdir $Workdir
exit $LASTEXITCODE
`
}

/**
 * Render one target family's start script.
 * @param spec - the deployment endpoints, the enrollment secret, and the target family.
 * @returns the complete script text.
 */
export function renderConnectorPack(spec: ConnectorPackSpec): string {
  return spec.os === 'windows' ? windowsPack(spec) : posixPack(spec)
}

/**
 * The single command a user can paste instead of downloading the file. It
 * fetches the same generated script and runs it, so the two routes install
 * exactly the same agent.
 * @param origin - the deployment origin the browser is on.
 * @param downloadPath - origin-relative path of the generated script.
 * @param os - target family the command is written for.
 * @returns the copyable one-line command.
 */
export function packInstallCommand(origin: string, downloadPath: string, os: ConnectorPackOs): string {
  const url = `${origin}${downloadPath}`
  return os === 'windows'
    ? `irm '${url}' | iex`
    : `curl -fsSL '${url}' | bash`
}
