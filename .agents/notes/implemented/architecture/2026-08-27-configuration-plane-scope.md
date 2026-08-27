# Agent Note: a declared scope decides who reaches the configuration plane

Status: implemented

English | [中文](2026-08-27-configuration-plane-scope.zh.md)

> Supersedes the caller boundary of [what the configuration plane exposes](2026-07-30-config-plane-boundaries.md): reading configuration is still as privileged as writing it, but "privileged" is no longer a synonym for "loopback". That note's redaction, mutate-by-path, and revision fencing remain current.

## Problem

A remote web deployment could not configure anything. Settings → Models opened with `加载提供方目录失败: settings are unavailable in this browser`, and no provider, endpoint, or key could be entered from the served page at all. Two independent gates produced it, and each would have produced it alone.

The Host `/api` fence pinned one `PRIVILEGED_METHODS` set to loopback by passing `isTrustedApiRequest` an empty trust list, so `settings.describe`, `credentials.describe`, and `llm.discoverModels` answered 403 to a declared `trustedHosts` authority — the deployment could authorize a host for `session.prompt`, which runs bash, and still not for reading its own model list.

The browser half then re-derived the same rule from the page hostname: `ui-settings` built its `SettingsDescribeMirror` in memory persistence whenever `ctx.connection.isLoopback` was false, and a memory-mode mirror starts in `unavailable` and never issues a read. That is where the sentence came from. Two copies of one policy, in two processes, neither reading the other, and the browser's copy could not see the deployment's `trustedHosts` configuration at all — so even relaxing the fence alone would have left the page dark.

Underneath both sat a conflation. `PRIVILEGED_METHODS` mixed methods that act on the caller's own configuration with methods that act on the operator's desktop. `host.openPath` and `settings.openDocument` open a file manager or an editor **on the machine running the host**; a remote browser gains nothing from them and the operator gains an unsolicited window. Those belong to loopback permanently and for a different reason than the settings domain does, but one set could only be relaxed as a whole.

## Decision

**Split the pinned methods by what they act on.** `NATIVE_DESKTOP_METHODS` — `host.pickDirectory`, `host.openPath`, `settings.openDocument`, `agentPreset.openDocument` — drive the host's own desktop and stay loopback under every configuration. `CONFIGURATION_PLANE_METHODS` — the `settings.*` and `credentials.*` domains, `llm.discoverModels`, and the `agentPreset.read`/`copy`/`remove` authoring methods — read and rewrite the user's configuration and secret store, and are the plane a remote operator legitimately needs. The model catalog (`llm.providers`, `llm.models`) stays outside both, unchanged: it carries provider ids, display names, and model lists, and a remote model picker needs it.

**One declared scope decides who reaches the second set.** `ConnectionConfig.configurationPlane` is `'loopback'` (the default, and the previous behavior exactly) or `'trusted-hosts'`, which passes the fence with the configured `trustedHosts` instead of an empty list. `dsh web --configuration-plane trusted-hosts` selects it for a CLI launch, threaded through `WebStartupValues` → `WebRuntimeValues` → the connection row, so the fence and the printed LAN URL read one resolved value.

**The Host publishes the scope; the browser does not guess it.** `client-connection`'s node half pushes `__DSH_CONFIGURATION_PLANE__` into every index render through `webserver/index-inject`, and the browser half reads that global into `ctx.connection.configurationPlane`. The settings surfaces gate on it; `ctx.connection.isLoopback` survives for the desktop-only actions, which is now the only thing it means. A page global carries no request context, so the browser still checks its own hostname when the scope is `'loopback'` — the deployment-wide answer narrowed by the page's own authority, never widened past it. Anything other than the exact string `'trusted-hosts'`, including an absent global, means loopback scope; test fixtures and the worker preview render no host index and get the closed default.

**`'trusted-hosts'` is stated as a trust decision, not a convenience.** `trustedHosts` is a DNS-rebinding fence, not authentication. Under this scope every caller that can reach the port may read the configuration, learn which environment variables hold credentials and where they resolve from, write new ones, and make the host issue a GET to a URL of their choosing. The flag's help text, both package READMEs, and the type's JSDoc say so: a deployment choosing it owes its users an authentication layer in front of the server. The default did not move, so no existing deployment's exposure changed.

## Testing

The fence split is asserted over a real HTTP server in `packages/client/connection/tests/node-half.host.spec.ts`, which the [boundary note](2026-07-30-config-plane-boundaries.md) established as the only honest way to check it: a declared authority is refused the configuration plane under the default scope and served it under `'trusted-hosts'`, while the native-desktop methods are refused under both. The same tests assert the injected `__DSH_CONFIGURATION_PLANE__` row, and `client-apply.client.spec.ts` asserts the browser handle takes the gate from that global rather than the page hostname — including a remote page the served scope opens and a remote page it does not.

No keyless snapshot covers this. The snapshot harnesses replay ACP and headless transcripts, which carry no browser page and therefore no page authority; the served web suite boots on loopback, where this change is a no-op by construction. What the change alters is only observable when the `Host` header names a non-loopback authority, so the evidence is the deployed run recorded in the pull request instead.

## Alternatives considered

- **Delete the browser-side gate and let a 403 speak.** The smallest diff, and it removes the duplicated fact outright — but the mirror reads once at `apply`, before connect, and the HTTP carrier turns a 403 into an untyped transport rejection. Every genuinely untrusted remote page would trade a designed message for a raw failure string, and detecting refusal would mean matching on that string. Rejected for the round trip and the string match, not for the honesty.
- **Publish the scope through the `host.describe` handshake.** The natural place for a served fact, and it arrives too late: `SettingsDescribeMirror` is constructed and `ensure()` runs before the first handshake, so consuming it would mean making mirror availability asynchronous and re-entrant — a much larger change to the settings seam than the bug warrants.
- **Inject the `trustedHosts` list rather than the scope.** Lets the browser reproduce the fence's decision exactly, including for an authority the deployment trusts but the page is not currently on. Rejected: it hands every visitor the deployment's internal hostnames, and the mismatch it fixes is invisible — the page in question is by definition being served to some other authority.
- **Make index injection request-aware.** The exact fix for that mismatch: the Host knows the request's `Host` header at render time and could answer per-request. It reaches the webserver's index renderer, the frontend static row, the worker preview's boot payload, and their docs — a rendering-pipeline change, for a case where the narrowed answer is already correct.
- **Change the shipped default to `'trusted-hosts'`.** Deployments would need no flag. Rejected outright: it would silently widen the configuration and secret store of every existing `--host 0.0.0.0` deployment, none of which asked for it.
- **A single `privilegedAccess` scope over the undivided set.** One config field instead of two method sets, and it would have opened `host.openPath` to remote callers as the price of opening `settings.describe`. The two sets differ in what they act on, so they differ in who may call them.

## Consequences

A deployment that passes `--configuration-plane trusted-hosts` can configure model providers from a remote browser: the catalog loads, credentials can be set, and discovery runs. It accepts in exchange that the port is the only fence in front of its secret store. A deployment that passes nothing behaves exactly as before, including the `settings are unavailable in this browser` message, which now means what it says — the Host declined to serve this page the plane.

`ctx.connection.isLoopback` no longer answers "may I configure?"; consumers that mean the configuration plane must read `configurationPlane`, and the two diverge on exactly the deployment this note enables. Every client test bench providing a `connection` fake supplies both, which is how the divergence stays visible in tests: `ui-settings-general` asserts a remote page served the plane still withholds the document action.

`packages/bundle/web-app` gained a source-plane reference to `packages/client/connection`'s host face for the scope type, the first host bundle to reference a client package's host tsconfig.

Still deferred, and unchanged by this note: authentication for remote deployments. `'trusted-hosts'` makes the plane reachable; it does not make it authenticated, and the fail-closed `describeForWire()` the [boundary note](2026-07-30-config-plane-boundaries.md) recorded remains the outstanding redaction work.
