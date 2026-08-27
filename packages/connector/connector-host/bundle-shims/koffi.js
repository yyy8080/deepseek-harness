/**
 * Build-time stand-in for `koffi` inside the single-file connector agent.
 *
 * `koffi` is a native addon, so it cannot be inlined into a file the target
 * machine runs without an install step, and leaving it external would abort the
 * agent at import time because `dsh-subprocess-local`'s Windows process
 * inspector imports it eagerly. The inspector is reached only from PTY terminal
 * allocation, which the connector operation set never performs, so the agent
 * inlines this module instead.
 *
 * `pointer` answers because the inspector resolves one pointer type while the
 * module evaluates; every other entry throws, which is what a bundled agent
 * asked for a Win32 terminal must do.
 * @module @deepseek-ai/dsh-connector-host/bundle-shims/koffi
 */

const NATIVE_UNAVAILABLE
  = 'connector agent: this single-file build ships no native modules, so PTY terminals are unavailable. '
    + 'Install @deepseek-ai/dsh-connector-host from npm to run terminals on this machine.'

/** Opaque stand-in for a koffi type handle; only identity is ever observed before a call throws. */
const TYPE_STUB = Object.freeze({ name: 'void*', size: 0 })

/**
 * Build a member that reports the missing native module.
 * @param member - the koffi entry point the caller reached.
 * @returns a function that always throws.
 */
const unavailable = member => () => {
  throw new Error(`${NATIVE_UNAVAILABLE} (koffi.${member})`)
}

export default {
  pointer: () => TYPE_STUB,
  array: () => TYPE_STUB,
  struct: unavailable('struct'),
  load: unavailable('load'),
  alloc: unavailable('alloc'),
  encode: unavailable('encode'),
  decode: unavailable('decode'),
}
