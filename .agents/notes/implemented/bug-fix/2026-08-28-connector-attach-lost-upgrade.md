# Agent Note: Answer a connector dial that lost its upgrade with 426

Status: implemented

English | [中文](2026-08-28-connector-attach-lost-upgrade.zh.md)

## Problem

A user ran a connector pack against the plain-HTTP test deployment and watched the agent fail:

```
dsh-connector: serving /workspace to http://119.45.184.191/connector/attach
dsh-connector-agent dialling http://119.45.184.191/connector/attach (linux, workdir /workspace)
```

Every dial was refused with `404`. The route was registered, the reverse proxy forwarded the prefix with `Upgrade` and `Connection` set, and an agent dialling `127.0.0.1:3082` on the same host attached on the first try — so nothing on the deployment could be found to be missing.

`Upgrade` and `Connection` are hop-by-hop headers, and a transparent proxy in the agent's egress path was removing both from plain-HTTP requests. A packet capture on the deployment showed the dial arriving at nginx already stripped, while the same request over TLS to the same host arrived intact. Node therefore never raised its `upgrade` event: the request reached the portal's ordinary prefix handler, which knows `/agent.mjs` and `/pack/<id>` and answered everything else — including its own attach path — with `404 not found`.

The status was the whole problem. `404` says the deployment does not serve this path, which sent the investigation at the deployed SHA, the nginx location, and the route registration. The one fact that mattered, that the request had lost its upgrade in transit, was the one nothing reported.

## Decision

`<basePath>/attach` is a path the portal owns, so a plain request that reaches it is answered as such: `426 Upgrade Required`, carrying the `Upgrade: dsh-connector` header the status requires, and a body naming both the cause and the remedy — an intermediary strips the hop-by-hop headers on plain HTTP, so dial an `https` origin, where the connection is tunnelled end to end.

The body is written to fit inside the 200 characters `runConnectorAttachment` prints of a refusal, because the operator who needs the diagnosis reads it in the agent's own output on the target machine, not in the deployment's logs.

Nothing about admission changes: an upgrade that arrives intact is admitted or refused exactly as before, and a foreign upgrade protocol is still dropped without an answer.

## Alternatives considered

**Carry the connector protocol over a transport that survives such a proxy.** Two half-duplex HTTP streams, correlated by enrollment, would attach through any intermediary that forwards chunked bodies. Rejected for this fix: it is a second transport to specify, version, and keep in step with the upgrade path, and the deployment that provoked the report already publishes a TLS origin that works. The 426 names that origin as the answer, which is what makes deferring the transport honest rather than silent.

**Fix only the deployment.** Publishing the portal over `https` unblocks this user and leaves the next one reading `404` on their own plain-HTTP host. The deployment change and the status change answer different halves of the report.

**Answer `400`.** It is accurate and says nothing. `426` is the status HTTP defines for precisely this — the request is well-formed but the server requires an upgrade — and its mandatory `Upgrade` header states which protocol without prose.

**Detect the stripped upgrade from the connector token header instead of the path.** Rejected: it would answer `426` only to requests that still carry a token, and a proxy free to drop hop-by-hop headers may drop others. The path alone is the reliable signal, and a browser that hits it gets the same true answer.

## Verification

`packages/host/connector-portal/tests/portal.spec.ts` drives the real agent loop against the real portal through a proxy that forwards everything except the hop-by-hop upgrade, and asserts the operator's report carries `HTTP 426` and the remedy in full — the truncation the message is sized for is exercised rather than assumed. A second test pins the status and the `Upgrade` response header for the stripped dial, and the existing `404` cases still cover paths the portal does not own.

On the deployment that produced the report, the plain-HTTP dial now prints the diagnosis in place of `404`, and the same pack pointed at that deployment's TLS origin attaches and answers a liveness probe from the same machine and network the failing dial came from. Publishing the connector prefix on a TLS origin and pinning the portal's `publicOrigin` to it is what makes the remedy the message names available there.

That deployment also showed how short an attachment's life is: it pins its attached machine as `connectors.default` in the composition, and writing that pin reloads this plugin, which drops the attachment whose id was just written. The portal README's `Known Limitations` now names the reload as one more thing the in-memory ledger does not survive.

## Consequences

A connector that cannot attach now says why on the machine that cannot attach. The remaining failure this does not fix is a target with no route to an `https` origin at all; that target still cannot attach, and now reads a message that says so instead of one that blames the endpoint.
