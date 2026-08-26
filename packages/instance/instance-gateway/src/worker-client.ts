/**
 * The control plane's client for one instance's `/api` gateway. The wire is
 * the same fetch carrier a browser uses, so an instance needs no gateway-only
 * protocol: `AbstractApiClient` already owns envelope minting, schema
 * validation, and SSE framing, and this subclass only redirects the base URL
 * to the instance origin and supplies Node's fetch.
 * @module @deepseek-ai/dsh-instance-gateway/worker-client
 */

import { AbstractApiClient } from '@deepseek-ai/dsh-host-apiproxy'

/** Fetch-carrier client bound to one instance origin. */
export class WorkerApiClient extends AbstractApiClient {
  /**
   * @param origin - the instance's HTTP origin, without a trailing slash.
   * @param timeoutMs - deadline for bounded unary calls; streams are unbounded.
   */
  constructor(private readonly origin: string, timeoutMs: number) {
    super(timeoutMs)
  }

  /** Every wire path resolves against the instance, never the control plane's own origin. */
  protected override resolveBase(): string {
    return this.origin
  }

  protected doFetch(input: URL, init?: RequestInit): Promise<Response> {
    return fetch(input, init)
  }
}
