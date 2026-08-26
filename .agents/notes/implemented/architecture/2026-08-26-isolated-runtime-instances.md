# Agent Note: isolated runtime instances behind one gateway

Status: implemented

## Problem

A harness process is one runtime: one filesystem, one shell, one session store, one agent. Every conversation a client creates shares them. Two conversations editing the same repository interleave their working-tree changes; a command one runs is visible to the other; a runaway process in one is a runaway process in all of them.

The product asks for the opposite: clicking "new chat" should get a conversation whose commands execute somewhere private, and several such conversations should run at once without crosstalk. Nothing in the harness named that "somewhere" — the closest existing entity is a workspace, which names a directory a user works in, not a machine that directory is reachable from.

The constraint that shapes the answer is the client. A browser holds one connection to `/api` plus two WebSocket downlinks. Fanning that out to one connection per runtime would move routing, reconnection, and stream merging into every client, and would make the runtime count visible in the transport.

## Decision

An **instance** is a first-class entity: a machine-like isolated runtime that exposes one harness `/api` gateway and hosts conversations. Four packages implement it, and the client is unchanged.

`@deepseek-ai/dsh-instance` is the Service Definition. It owns instance identity (branded `InstanceId`), the desired/observed state machine (`stopped` / `starting` / `running` / `stopping` / `failed` against a `running` / `stopped` desired state), and publication on `instance/changed`. It owns no isolation mechanics.

`@deepseek-ai/dsh-instance-local-process` is the first Service Provider: one child harness per instance, each with its own `DSH_HOME`, its own workspace directory, and its own loopback port, all under `<root>/<instanceId>/`. Isolation here is filesystem-and-process scoped, not kernel scoped. A container or remote-sandbox provider replaces it without a consumer change, which is why the seam exists at all.

`@deepseek-ai/dsh-worker` is the bundle those children boot: the browser surface's host half without the browser — one loopback `/api`, no frontend dist, no client plugin roster, no native-open handoff. `dsh --profile worker` is the command a provider supervises.

`@deepseek-ai/dsh-instance-gateway` is the Consumer. It provides `ctx.apiProxy` in place of the single-runtime gateway, so the client's existing carriers reach many runtimes unchanged. Session-bearing domains route to the instance that owns the session; the host plane answers from the control plane's own `createApiProxy` composition; the two event streams merge the control plane's with one per running instance.

### Readiness is a file, not a log line

A worker binds an OS-assigned port, so its supervisor cannot know the origin in advance. The worker renames a complete `{"origin":"…"}` file into place at the path named by `DSH_INSTANCE_ENDPOINT_FILE` once the whole Loader tree has settled, and the provider polls for that file.

A file rather than parsed output because a rename is atomic — a partially written origin is never observable — and because it separates "the process started" from "the process serves requests". After the Loader settles rather than when the server binds, because a supervisor treats the handshake as "this runtime answers now", and the `/api` route owner mounts as a sibling row.

### Global session ids

Each instance mints session ids from its own store, so two instances can and eventually will mint the same one. Clients see `<instanceId>~<localSessionId>`; the gateway rewrites at the edge, and instances never see a global id.

Rewriting is by JSON property name — `sessionId`, `parentSessionId`, `childSessionId`, `beforeSessionId`, and the `sessionIds` / `archivedSessionIds` arrays — not by value pattern. Property names are what leave call ids, message ids, and approval ids untouched; a value pattern would have to guess, and every guess is either a missed rewrite or a corrupted foreign id.

A session id addressed to a different instance than the one a call routes to fails loudly. Passing it through would make the receiving instance answer `session-not-found` for an id that does exist, one runtime over — the least diagnosable outcome available.

`~` is unreserved in URLs, so a global id survives the session-log download's query string. Instance ids may not contain it; the package's invariant companion checks that against the registry's authoritative stream, because a violation would silently route one instance's sessions to another.

### Placement is session creation

`session.create` resolves the instance first and only then creates the session inside it. The conversation's shell, filesystem, and session log therefore live in that runtime from its first event, with no later attachment step and no window in which a conversation exists somewhere it will not run.

`per-conversation` derives the instance label from the caller's preallocated session id, so the documented create-retry contract still lands on the same runtime. `shared` places every conversation in one runtime, for deployments that want isolation from the control plane rather than between sibling conversations.

Placement past `maxInstances` fails loudly rather than queueing. Each instance is a whole harness process; silently waiting for one to free up would present as a hung "new chat", and the operator would have no way to tell it from a broken model call.

### What a forwarded create drops

`workspaceId`, `cwd`, and `agentPreset` name the control plane's own world: its workspace registry, its filesystem, and a preset roster the worker bundle does not mount. They are dropped rather than forwarded, so the session lands in the instance's own workspace under the instance's own agent.

## Alternatives considered

**One browser connection per runtime.** The client would open `/api` against each instance directly, and the control plane would only hand out addresses. It deletes the gateway entirely, and it deletes id namespacing with it — each connection is already scoped to one store. It loses on the client: reconnection, stream merging, per-instance auth, and cross-instance ordering all move into every client shape, and the runtime count becomes visible in the transport. The locked constraint is one connection.

**SDK stdio or ACP as the worker protocol.** Both already exist and both already run a harness in a child process. Neither carries the domains a browser client needs — the workspace registry, the settings and credential planes, session search, the projection stream — so the gateway would translate rather than route, and every new `/api` method would need a second translation. Reusing the `/api` wire means a worker is reachable by anything that can already talk to a harness, including `curl` during this work.

**Sessions addressed by a gateway-minted opaque id.** The gateway would keep a map from its own id to `(instance, localSessionId)` instead of encoding both in the id. It hides the instance from clients, which is tidier, and it survives an instance id changing. It loses because the map is state: it must be durable to survive a control-plane restart, and a restart that lost it would strand every conversation. The composed id is stateless — any process holding the registry can route.

**A workspace that names a runtime.** Reusing `WorkspaceId` would have avoided a new entity. It conflates two lifetimes: one instance hosts many workspaces, and the same workspace path exists in several instances. The registry would have had to grow a second identity anyway, under a name that means something else.

**Terminal-bridging a conversation into a runtime.** The original framing was that a conversation stays in the control plane and gets a terminal inside the runtime. That leaves the session log, the filesystem tools, and the agent in the control plane, so only shell commands are isolated — file edits are not. Moving the whole session into the runtime makes every tool it has isolated by construction, and the shell it already carries is the terminal.

## Consequences

The client is unchanged: this landed with no edit under `packages/client`. Everything that reads `ctx.apiProxy` — the `/api` HTTP bridge, both WebSocket downlinks, the session-log download — reaches many runtimes because the service under them changed, not the carriers.

Cold start is now on the "new chat" path under `per-conversation`. Booting a harness is the cost of the isolation, and it is paid where the user asked for a new conversation.

The gateway's worker client reads the two event streams over WebSocket rather than the base carrier's SSE. A harness serving `/api` through `@deepseek-ai/dsh-client-connection` answers `GET /api/events.mux` with 426 Upgrade Required, so the SSE reader `AbstractApiClient` ships cannot reach a worker.

The control plane's workspace registry does not see instance sessions, so a client's workspace grouping is empty and conversations present as ungrouped. Grouping by instance is the natural replacement and needs a client change; `@deepseek-ai/dsh-instance-gateway`'s README owns this and the rest of the current gaps.

Answerable-frame routing is process-local: the `rpcId` → instance map lives in memory, so a control-plane restart drops routing for approvals and questions already in flight.

## Testing

`packages/instance/instance/tests/registry.spec.ts` pins the state machine: transitions announce only after they commit, an endpoint is published exactly while running, concurrent starts join one transition, a failed start clears on retry, a stop whose runtime rejects reports `failed` rather than `stopped`, removed ids are never reused, and disposal reaches every live runtime including one that finishes starting after teardown began. The endpoint-exactly-while-running case found a real defect: a stopping instance still holds its runtime handle so the stop can reach it, and its view was publishing that dead endpoint.

`packages/instance/instance-gateway/tests/` pins id rewriting in both directions and the fan-in buffer's arrival order, close, abort, and cleanup behavior.

`examples/instance-runtimes/` is the assembled path. No snapshot covers it yet: the snapshot harness replays one runtime's transcript, and a multi-runtime transcript needs harness support for per-instance replay. Until then the example is verified by hand — two conversations land on distinct runtimes with distinct `cwd` values, the merged mux stream carries globalized frames from every runtime including one started after the stream opened, and an unroutable session id is refused.
