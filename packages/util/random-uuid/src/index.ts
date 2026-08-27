/**
 * Insecure-origin-safe RFC 4122 version 4 UUID minting.
 * @module @deepseek-ai/dsh-random-uuid
 */

/**
 * Mint a random RFC 4122 version 4 UUID.
 *
 * Browsers expose `crypto.randomUUID` only in a secure context (HTTPS or a
 * loopback origin), so a page served over plain HTTP from a LAN or public IP
 * has no such method. `crypto.getRandomValues` carries no such restriction and
 * backs the fallback, which produces the same variant-1 version-4 layout from
 * the same CSPRNG.
 * @returns a lowercase hyphenated version-4 UUID.
 */
export function randomUuid(): string {
  const source = globalThis.crypto
  if (typeof source.randomUUID === 'function') return source.randomUUID()
  const bytes = source.getRandomValues(new Uint8Array(16))
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  view.setUint8(6, (view.getUint8(6) & 0x0f) | 0x40)
  view.setUint8(8, (view.getUint8(8) & 0x3f) | 0x80)
  const hex = Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}
