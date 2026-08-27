# Agent Note: Mint browser UUIDs without a secure context

Status: implemented

English | [中文](2026-08-27-insecure-context-uuid-minting.zh.md)

## Problem

`crypto.randomUUID` is a secure-context-only Web API. A browser exposes it over HTTPS and over a loopback origin, and withholds it over plain `http://<lan-or-public-ip>/`, where the property is simply absent and a call throws `crypto.randomUUID is not a function`. `AbstractApiClient.mintRpcId` minted every typed API rpcId with it, so a page served over plain HTTP from a LAN or public address threw before its first `host.describe` POST left the browser: the readiness handshake never completed, the two downlink WebSockets were torn down and retried forever, and the UI stayed on `Loading plugins…`. Workspace selection was the first thing a user reached for, so that is where the error surfaced.

The same trap already caught the generic Connection RPC caller, which had grown a private `randomUuid` helper in `dsh-client-connection`. That helper was correct and unreachable from the package that actually carries the typed API: `dsh-host-apiproxy` sits below `dsh-client-connection`, and a UI package minting a browser-local draft id could reach neither.

## Decision

The helper moves to `@deepseek-ai/dsh-random-uuid`, a zero-dependency package under `packages/util/`, and becomes the single id source for every code path that can execute in a browser: `AbstractApiClient.mintRpcId`, `createWebConnectionRpc`, the connection fixture carrier, and the ui-conversation composer's draft attachment id.

It prefers `crypto.randomUUID` where the platform exposes it and otherwise derives the same version-4, variant-1 layout from `crypto.getRandomValues`, which carries no secure-context restriction and is backed by the same CSPRNG. Node ≥ 19 always takes the first path, so host-side behavior is unchanged. Host-only code that never ships to the browser keeps `node:crypto`'s `randomUUID`.

A platform exposing neither method throws. There is deliberately no `Math.random` path: silently degrading id entropy is worse than a loud failure, and every engine in the supported range has one of the two.

## Alternatives considered

**Serve the deployment over HTTPS instead.** Rejected as the fix. A certificate makes the symptom disappear on one deployment while leaving every plain-HTTP LAN, container, and IP-addressed test host broken. Every other part of the browser wire path already works without TLS.

**Keep the helper in `dsh-client-connection` and import it from apiproxy.** Rejected because it inverts the dependency direction: `dsh-client-connection` depends on `dsh-host-apiproxy`, not the reverse.

**Put the helper in the apiproxy `api/` contract layer.** That layer is browser-importable and already holds `RpcId`, so the fetch carrier and connection could both reach it. Rejected because a UI package minting a browser-local draft id would then depend on the API gateway package for a random number, and the helper is not part of any wire contract.

**Reuse `dsh-brand`.** Rejected because that package is type-only and erased at compile time; adding runtime code to it would change what it is.

## Verification

Package tests cover both paths of `randomUuid`: delegation when `crypto.randomUUID` exists, the exact fallback bytes for a scripted `getRandomValues`, version and variant stamping across saturated byte patterns, and distinctness from the real platform CSPRNG. `packages/host/apiproxy/tests/fetch-carrier.spec.ts` drives a full `sessions.list` through `AbstractApiClient` with `crypto` stubbed down to `getRandomValues` alone and asserts the minted rpcId is a v4 UUID; `packages/client/connection/tests/client-apply.client.spec.ts` holds the equivalent assertion for the generic RPC caller.

The fixed build was deployed to the plain-HTTP test host at `http://119.45.184.191/` and driven with headless Chromium: the page reports `isSecureContext: false` and `typeof crypto.randomUUID === 'undefined'`, and the workspace list still loads and selects.

## Consequences

Every browser-reachable id now comes from one place, so a future call site cannot silently reintroduce the secure-context dependency in a package that also runs in the page. `dsh-host-apiproxy`, `dsh-client-connection`, and `dsh-client-ui-conversation` gain a dependency on a package with no dependencies of its own. The rpcId is no longer guaranteed to come from the platform's own UUID implementation on insecure origins, which is immaterial: both paths draw from the same CSPRNG, and the value is a correlation token, not a security token.
