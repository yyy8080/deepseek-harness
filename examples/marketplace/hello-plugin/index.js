/**
 * The sample marketplace plugin's runtime: a Cordis function plugin that
 * publishes one greeting a composition can read back, so an end-to-end install
 * has something observable to assert besides the profile manifest.
 * @module dsh-plugin-hello-marketplace
 */

/** Cordis plugin name used by loader diagnostics. */
export const name = 'hello-marketplace'

/** The greeting this plugin publishes on the context it mounts into. */
export const HELLO_MARKETPLACE_GREETING = 'hello from the marketplace sample plugin'

/**
 * Publish the greeting for the lifetime of this plugin's fiber.
 * @param {import('@deepseek-ai/cordis').Context} ctx - the mounting context.
 */
export function apply(ctx) {
  ctx.provide('helloMarketplace', HELLO_MARKETPLACE_GREETING)
}
