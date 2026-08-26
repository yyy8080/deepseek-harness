#!/usr/bin/env node
/**
 * `dsh-connector-agent` — serve one machine's filesystem and processes to a
 * DeepSeek Harness deployment running anywhere else.
 * @module @deepseek-ai/dsh-connector-host/bin
 */

import { runConnectorAgent } from './agent.ts'

await runConnectorAgent(process.argv.slice(2)).catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
  process.exitCode = 1
})
