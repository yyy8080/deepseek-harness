/** Deterministic keyless adapter that proves one bash round trip over a connector. */

import { CallId, LlmAdapter } from '@deepseek-ai/dsh-llm'

const COMMAND = 'cat connector-probe.txt'

class ConnectorFixtureAdapter extends LlmAdapter {
  async * stream(options) {
    const result = options.messages.at(-1)?.content.find(block => block.type === 'tool-result')
    if (result === undefined) {
      const args = JSON.stringify({ command: COMMAND, description: 'Read the probe file on the connector.' })
      yield { type: 'block-start', index: 0, blockType: 'tool-call' }
      yield { type: 'tool-call-delta', index: 0, id: CallId('connector-probe-call'), name: 'bash', argumentsDelta: args }
      yield {
        type: 'block-end',
        index: 0,
        block: { type: 'tool-call', id: CallId('connector-probe-call'), name: 'bash', arguments: args },
      }
      yield { type: 'usage', usage: { inputTokens: 13, outputTokens: 4 } }
      yield { type: 'finish', reason: { kind: 'tool-calls' } }
      return
    }

    const text = result.content.filter(block => block.type === 'text').map(block => block.text).join('').trim()
    const reply = `connector round trip complete: ${text}`
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'text-delta', index: 0, text: reply }
    yield { type: 'block-end', index: 0, block: { type: 'text', text: reply } }
    yield { type: 'usage', usage: { inputTokens: 9, outputTokens: 6 } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

/** Cordis plugin name. */
export const name = 'connector-fixture-llm'
/** LLM registry dependency. */
export const inject = ['llm']

/**
 * Register the keyless adapter on the shipped default provider route.
 * @param ctx - the mounting context.
 */
export function apply(ctx) {
  ctx.llm.registerAdapter(['deepseek-official'], new ConnectorFixtureAdapter())
}
