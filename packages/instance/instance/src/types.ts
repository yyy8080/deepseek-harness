/**
 * Type-only vocabulary of the instance capability seam: the branded id, the
 * lifecycle states, the endpoint an instance publishes, and the Service
 * Provider protocol a runtime backend implements.
 * @module @deepseek-ai/dsh-instance/types
 */

import type { Branded } from '@deepseek-ai/dsh-brand'

/**
 * Opaque identity of one isolated runtime, minted by the registry. Distinct
 * from every workspace, session, and agent id: an instance is a machine-like
 * container that outlives the conversations placed inside it.
 */
export type InstanceId = Branded<'InstanceId'>

/**
 * Observed lifecycle of one instance. `failed` is terminal until the next
 * explicit start; it never self-heals, so a caller always sees the failure
 * that produced it.
 */
export type InstanceLifecycle = 'stopped' | 'starting' | 'running' | 'stopping' | 'failed'

/** What the registry is currently driving the instance towards. */
export type InstanceDesiredState = 'running' | 'stopped'

/** Where a running instance answers, and which directory tree it owns. */
export interface InstanceEndpoint {
  /**
   * HTTP origin of the instance's own `/api` gateway, without a trailing
   * slash (`http://127.0.0.1:41234`). Consumers append the wire path.
   */
  origin: string
  /**
   * Absolute root of the isolated state this instance owns — its harness
   * home and workspace tree. Reported for display and cleanup; the control
   * plane never reads inside it.
   */
  root: string
}

/** One instance as the registry publishes it; a plain value, safe to serialize. */
export interface InstanceView {
  id: InstanceId
  /** Human-facing name; unique among live instances so a UI can group by it. */
  label: string
  /** Registered provider that owns this instance's runtime. */
  provider: string
  desired: InstanceDesiredState
  lifecycle: InstanceLifecycle
  /** Present exactly while `lifecycle` is `running`. */
  endpoint?: InstanceEndpoint
  /** The failure that produced `lifecycle: 'failed'`; absent otherwise. */
  failure?: string
}

/** What the registry hands a provider when it starts one instance. */
export interface InstanceStartRequest {
  /** Registry-minted identity; providers use it for their own naming. */
  id: InstanceId
  /** The instance's human-facing name. */
  label: string
  /** Aborts when the registry gives up waiting or the owning fiber disposes. */
  signal: AbortSignal
}

/** A live runtime a provider has started and still owns. */
export interface InstanceRuntime {
  /** Where the started runtime answers. */
  endpoint: InstanceEndpoint
  /**
   * Terminate the runtime and release every resource it holds. Resolves only
   * once the runtime is gone, so the registry can report `stopped` truthfully;
   * a rejection moves the instance to `failed`.
   */
  stop(): Promise<void>
}

/**
 * Service Provider protocol of the instance seam. One implementation per
 * isolation technology (a local worker process, a container, a remote
 * sandbox); the registry owns identity, state, and publication.
 */
export interface InstanceProvider {
  /** Registry key; a duplicate registration fails loud. */
  name: string
  /**
   * Start one isolated runtime and resolve once it answers requests.
   * @param request - registry-minted id, label, and the give-up signal.
   * @returns the live runtime handle the registry will later stop.
   */
  start(request: InstanceStartRequest): Promise<InstanceRuntime>
}

/** What a caller asks the registry to create. */
export interface InstanceCreateRequest {
  /** Provider name; an unregistered name fails loud. */
  provider: string
  /** Human-facing name; a duplicate among live instances fails loud. */
  label: string
}
