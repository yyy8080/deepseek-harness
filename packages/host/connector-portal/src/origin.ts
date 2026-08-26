/**
 * The origin a generated pack dials back to, derived from the download request.
 *
 * The deployment cannot know its own public address: it binds a port, and a
 * reverse proxy decides which scheme, name, and port users reach it under. The
 * browser that asked for the pack already knows all three, and states them in
 * the request. Reading them back is what makes one build serve a laptop on
 * `http://127.0.0.1:3080` and a server behind `https://harness.example.com`
 * without configuration.
 *
 * The headers are attacker-controlled, and the value ends up inside a script
 * the target executes, so this module accepts only a canonical authority and a
 * known scheme. A request whose Host it cannot vouch for yields nothing and the
 * caller answers with a failure instead of a guess.
 *
 * @module @deepseek-ai/dsh-host-connector-portal/origin
 */

import type { IncomingHttpHeaders } from 'node:http'

/** Read one request header as text, ignoring a repeated header. */
function single(headers: IncomingHttpHeaders, name: string): string | undefined {
  const value = headers[name]
  return typeof value === 'string' ? value : undefined
}

/**
 * The forwarded scheme, when a proxy stated exactly one it is willing to name.
 * A list — the `proto1, proto2` form a chain of proxies appends — is refused
 * rather than resolved, because the correct member is a deployment fact this
 * module cannot see.
 */
function forwardedScheme(headers: IncomingHttpHeaders): 'http:' | 'https:' | undefined {
  const value = single(headers, 'x-forwarded-proto')?.trim().toLowerCase()
  if (value === 'http') return 'http:'
  return value === 'https' ? 'https:' : undefined
}

/**
 * Derive the absolute origin one request reached this deployment through.
 * @param headers - the request headers, verbatim.
 * @returns the origin, or undefined when the Host is absent or not a canonical authority.
 */
export function requestOrigin(headers: IncomingHttpHeaders): string | undefined {
  const authority = single(headers, 'host')
  if (authority === undefined) return undefined
  const scheme = forwardedScheme(headers) ?? 'http:'
  let url: URL
  try {
    url = new URL(`${scheme}//${authority}`)
  } catch {
    return undefined
  }
  // WHATWG parsing rewrites more than it rejects: a Host carrying credentials,
  // a path, or a non-canonical host spelling parses into something that is no
  // longer what the client sent. Only a Host that survives the round trip
  // unchanged is one this deployment can put into a script.
  return url.host === authority.toLowerCase() && url.pathname === '/' && url.search === '' && url.username === ''
    ? url.origin
    : undefined
}
