/**
 * Build-time stand-in for `node-pty` inside the single-file connector agent.
 *
 * `node-pty` is a native addon that cannot be inlined into a file the target
 * machine runs without an install step. Only PTY terminal allocation reaches
 * it, and the connector operation set — filesystem reads and writes plus
 * one-shot commands — never allocates one, so the agent inlines this module and
 * fails loudly if a terminal is ever requested.
 * @module @deepseek-ai/dsh-connector-host/bundle-shims/node-pty
 */

const NATIVE_UNAVAILABLE
  = 'connector agent: this single-file build ships no native modules, so PTY terminals are unavailable. '
    + 'Install @deepseek-ai/dsh-connector-host from npm to run terminals on this machine.'

/**
 * Reject a PTY allocation request against a build that carries no PTY.
 * @returns never; always throws.
 */
export function spawn() {
  throw new Error(`${NATIVE_UNAVAILABLE} (node-pty.spawn)`)
}

export default { spawn }
