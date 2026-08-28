/**
 * Browser-safe, zero-dependency declaration of which authorities may reach the
 * configuration plane — the `settings.*`, `credentials.*`, `agentPreset`
 * authoring, and `llm.discoverModels` methods that read and mutate the user's
 * configuration and secret store. The `/api` fence enforces the scope, and the
 * node half publishes the same value as a page global so the browser half
 * gates its configuration surfaces on the host's answer instead of a second
 * guess of its own.
 */

/**
 * Who the deployment serves the configuration plane to.
 *
 * `loopback` is the default and the only scope that is safe without an
 * authentication layer: the plane stays same-origin on the machine running the
 * host. `trusted-hosts` extends it to the authorities in `trustedHosts`, which
 * is a DNS-rebinding fence and NOT authentication — choosing it means every
 * caller that can reach the port may read and rewrite the configuration.
 */
export type ConfigurationPlaneScope = 'loopback' | 'trusted-hosts'

/** Page global carrying the served {@link ConfigurationPlaneScope}. */
export const CONFIGURATION_PLANE_GLOBAL = '__DSH_CONFIGURATION_PLANE__'

/** The scope a deployment gets when it declares none. */
export const DEFAULT_CONFIGURATION_PLANE_SCOPE: ConfigurationPlaneScope = 'loopback'
