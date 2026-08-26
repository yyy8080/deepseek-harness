# @deepseek-ai/dsh-instance

English | [中文](README.zh.md)

Isolated-runtime seam. `InstanceRegistry` registers as `ctx.instances`, mints opaque `InstanceId`s, drives each instance through a desired/observed state machine, and publishes every committed transition on `instance/changed`. Providers own how a runtime is isolated — a worker process with its own harness home, a container, a remote sandbox — and expose it as one HTTP origin serving the harness `/api` gateway.

## Contract

- An instance is not a workspace. A workspace names a directory a person works in; an instance names the runtime that directory is reachable from. One instance hosts many workspaces, and the same path may exist in several instances.
- `registerProvider` keys on the provider's `name`; a duplicate registration throws `DUPLICATE_PROVIDER`, and the returned disposer removes the registration.
- `create` registers an instance in `stopped` and starts nothing. Labels are unique among live instances, so a control plane can address one by name; a duplicate throws `DUPLICATE_LABEL`, and an unregistered provider throws `NO_PROVIDER`.
- `start` and `stop` are idempotent and joinable: a second caller during a transition awaits the first one's outcome instead of starting a second runtime.
- `endpoint` is present exactly while `lifecycle` is `running`, and `failure` exactly while it is `failed`. `failed` is terminal until the next explicit `start`, which clears the previous failure before attempting.
- A stop whose runtime rejects lands in `failed`, not `stopped`: the registry cannot confirm the runtime is gone, so it does not claim so.
- `ensureRunning` is the placement entry point — it resolves an existing label or creates one, starts it, and rejects with `START_FAILED` unless the instance reaches `running`. Callers never observe a half-started instance.
- Registry disposal stops every live runtime and awaits each stop, reporting rather than throwing on a runtime that refuses to die. A start that completes during disposal stops the runtime it just received.
- `remove` stops first and never reuses an id, so a stale reference fails loud instead of reaching a different runtime.

The seam contains no process, container, HTTP, session, or routing policy. Providers own isolation mechanics; consumers own placement and multiplexing.

## Model Experience

### Indirect consumer

#### What the model sees

Nothing directly. This package registers no prompt, tool, or session event. A model running inside an instance sees only its own runtime, which is the point of the seam.

#### Token effect

None directly.

#### KV Cache effect

No direct invalidation.

## Known Limitations and Deferred Work

- The registry is process-local: instances are not restored after a control-plane restart, so a surviving worker process is orphaned rather than re-adopted.
- There is no pool, quota, or scheduling policy. Placement decisions belong to consumers, and a consumer that creates one instance per conversation pays a full cold start for each.
- Labels, not ids, are the addressable key in `ensureRunning`; a consumer that wants stable addressing across restarts must derive its labels deterministically.
