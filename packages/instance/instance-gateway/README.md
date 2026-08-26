# @deepseek-ai/dsh-instance-gateway

English | [中文](README.zh.md)

Multiplexing API gateway over the [instance seam](../instance/README.md). It provides `ctx.apiProxy`, so every carrier already mounted by `@deepseek-ai/dsh-client-connection` — the `/api` HTTP bridge, the `events.mux` and `events.host` WebSocket downlinks, and the session-log download — keeps working while the conversations behind them run inside separate isolated runtimes.

Mount it **instead of** `@deepseek-ai/dsh-host-apiproxy`'s own `ApiProxyService`; both provide the same service name, and two providers of one service fail the load.

## What routes where

| Domain | Answered by |
| --- | --- |
| `sessions`, `subagents`, `skills`, `goals` | the instance that owns the session named in the payload |
| `session.list`, `session.search` | every running instance, concatenated |
| `session.create` | a freshly resolved instance (see [Placement](#placement)) |
| `events.mux`, `events.host` | the control plane's own stream merged with one stream per running instance |
| `respond` | the instance whose answerable frame carried the `rpcId` |
| `downloads.sessionLog` | the instance named by the global session id |
| `host`, `workspace`, `agentPresets`, `settings`, `credentials`, `llm` | the control plane's own composition |

## Global session ids

Each instance mints session ids from its own store, so two instances can mint the same one. The gateway therefore shows clients `<instanceId>~<localSessionId>` and rewrites at the edge: instances never see a global id, and the control plane never routes on a local one. Rewriting is by JSON property name (`sessionId`, `parentSessionId`, `childSessionId`, `beforeSessionId`, and the `sessionIds` / `archivedSessionIds` arrays), which is what leaves call ids, message ids, and approval ids untouched.

A session id addressed to a different instance than the one a call is routed to fails loudly rather than passing through: the receiving instance would answer `session-not-found` for an id that does exist one runtime over.

## Placement

`session.create` resolves the instance before creating the session, so the conversation's shell, filesystem, and session log live in that runtime from its first event.

- `per-conversation` (default) derives the instance label from the caller's preallocated session id, giving every conversation its own runtime. A retried create with the same preallocated id lands on the same runtime.
- `shared` places every conversation in the single instance named by `sharedLabel`.

`workspaceId`, `cwd`, and `agentPreset` are dropped from a forwarded create: each names something in the control plane's own world (its workspace registry, its filesystem, a preset roster the worker bundle does not mount), so the session lands in the instance's own workspace under the instance's own agent.

## Configuration

```yaml
- '@deepseek-ai/dsh-instance-gateway':
    provider: local-process
    placement: per-conversation
    sharedLabel: shared
    maxInstances: 8
    requestTimeoutMs: 60000
```

| Key | Meaning |
| --- | --- |
| `provider` | required; the instance provider new conversations are placed on |
| `placement` | `per-conversation` or `shared` |
| `sharedLabel` | instance label `shared` placement resolves |
| `maxInstances` | ceiling on registered instances; placement past it fails loudly rather than queueing |
| `requestTimeoutMs` | deadline for one unary call to an instance; the event streams are unbounded |

An unregistered `provider` fails the first placement, not the load: providers register on their own fibers and may not have applied when this service constructs.

## Model Experience

None, as the gateway routes already-composed API messages between runtimes; the instance a conversation lands in owns every prompt, tool schema, and session event that conversation's model sees.

#### KV Cache effect

None; this package neither assembles nor sends a provider request.

## Known Limitations and Deferred Work

- **The control plane's workspace registry does not see instance sessions.** `workspace.list` answers from the control plane, while sessions live in instances, so a client's workspace grouping stays empty and conversations present as ungrouped. Grouping by instance is the natural replacement and needs a client change.
- **`session.list` pagination is per-instance.** The fan-in concatenates each instance's first page and takes the non-array response fields from the last contributing instance; a cursor that spans instances needs a composite cursor.
- **Instance CRUD is not exposed on the wire.** Placement is implicit in `session.create`; `ctx.instanceGateway.placeConversation` is the in-process entry point. A `/instances` channel over `ctx.connection.rpc.handle` is the intended surface.
- **Answerable-frame routing is process-local.** The `rpcId` → instance map lives in memory, so a control-plane restart drops the routing for approvals and questions that were already in flight; the client reopens its streams and the instances replay them, but the replayed frames arrive with fresh routing only after the merge reattaches.
