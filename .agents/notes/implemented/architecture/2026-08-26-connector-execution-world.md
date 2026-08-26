# Agent Note: Connectors — the execution world lives on a machine the backend chooses

Status: implemented

English | [中文](2026-08-26-connector-execution-world.zh.md)

## Problem

A harness deployment had exactly one execution world available to it: the process's own machine. Every filesystem and subprocess provider that shipped either operated on the host (`dsh-fs-local`, `dsh-subprocess-local`) or created a fresh disposable one it owned end to end (`dsh-fs-e2b`, `dsh-subprocess-e2b`). That forces the backend and the terminal onto the same host: to give an agent access to a developer's build machine, a lab Windows box, or an existing server, the whole harness had to be deployed there — with its model credentials, session store, approval flow, and plugin graph.

The [portable execution-world decision](2026-07-28-portable-execution-world-consumers.md) already established that `ctx.fs` and `ctx.subprocess` together define one execution world, and that a remote world is a pair of Service Providers rather than a fork of every consumer. What it did not establish is how a deployment names several such worlds, how a conversation picks one, or what protocol reaches a machine the operator already has instead of a sandbox vendor's API.

E2B answered none of these: it creates its own Linux sandbox, has no notion of a target the operator supplies, has no Windows story, and has no per-session selection — the sandbox is a deployment-wide singleton.

## Decision

A **connector** is a first-class capability seam (`ctx.connectors`) naming one machine and one operating-system family. The registry holds the connectors a deployment configured, resolves which one a session runs on, and hands out one shared link per connector. `dsh-fs-connector` and `dsh-subprocess-connector` implement the two execution-world seams over that link. Consumers above them are unchanged, because they already state every operation in terms of `ctx.fs` and `ctx.subprocess`.

Four choices carry the design.

**The binding is a session event.** `bindSessionConnector` appends one `connector/bound` event and `effectiveConnectorId` folds the log back to the last one, exactly as `sandbox/mode` does for execution policy. The session log is the store, so a conversation's target machine survives restart by replay and two conversations never see each other's. The event is log-only: it is durable and replayable but never enters the model transcript, so it needs no surface operation. Providers resolve the fold at every operation boundary, which is what keeps the filesystem and the subprocess seams agreeing on one world even though nothing passes a session between them — both read the initiating-agent scope, the only ambient carrier either seam exposes.

**The target side reuses the shipped local providers.** `createConnectorHost` builds a private Cordis application holding nothing but `dsh-fs-local` and `dsh-subprocess-local` and projects it onto the connector operation set. Filesystem identity, atomic publication, line-ending handling, process trees, PATH and PATHEXT lookup, and Windows tree termination therefore keep exactly one implementation, whether the agent runs beside the harness or on another machine. Windows support is not a separate port; it is what `dsh-subprocess-local` and `dsh-fs-local` already do when they run on Windows.

**The wire is newline-delimited JSON over TCP.** It needs no dependency on either side, runs unchanged on Linux and Windows, and tunnels through `ssh -L` without a proxy that understands the payload. The frame set is a `hello`/`ready` handshake carrying the protocol revision, correlated `call`/`result`/`error` frames, `cancel`, and server-initiated `event` frames for a process's output, close, failure, and tree-exit. Frames are validated on arrival and bounded, because a peer is remote and unauthenticated until the handshake completes.

**The path dialect belongs to the connector, not the host.** `processPath`, `fileUrl`, and `contains` must stay synchronous, so they cannot ask the target. The descriptor's OS family selects `posix` or `win32` for all three, which is why the OS is a required part of a declaration and why the agent must confirm it in the handshake: a Linux harness driving a Windows target has to produce `file:///C:/…` and Windows containment rules, and a declaration the agent contradicts is refused rather than silently trusted.

Two smaller consequences are worth recording. Process identifiers are assigned by the **client** in the spawn call, so the client installs its observer before the target can deliver the first notification — the alternative loses a spawn failure that arrives before the round-trip returns. And closing a connection aborts that client's in-flight calls and terminates the trees it started, so a client cannot leave work running on a target by disconnecting.

## Consequences

The agent loop, model calls, tool orchestration, session log and persistence, approvals, skills, and the plugin graph all stay in the harness process. A connector moves file and process operations and nothing else. It is not a sandbox: confinement on a shared target remains the sandbox seam's concern, and connectors compose with it rather than replace it.

A deployment that mounts the connector-backed providers accepts three limits. Persistent terminals are unavailable on a connector: `spawnTerminal` reports `CONNECTOR_UNSUPPORTED`, so a persistent-shell capability must stay on a local execution world. Collected output is a bounded in-memory tail with no spill file, so a truncated stream reports its truncation but offers no path to the rest. And a remote spawn cannot report a pid synchronously, so `handle.pid` is `-1` until the round-trip returns, as it already is for E2B.

The TCP agent is an unconfined remote-execution surface guarded by one shared token: anything it can read, write, or run, a client holding that token can. The agent therefore refuses to start without a token, and both the package documentation and the example configuration bind loopback and reach the target through `ssh -L`. An operator who binds a routable address is exposing the target machine.

## Verification

Package suites pin the registry's resolution, memoization, and disposal; the session fold and its write path; frame encoding, validation, and limits; the host's projection of both seams over a temporary directory; and both capability providers driven through a real in-process connector, including the routing proof that a session bound to a different connector reaches a different machine. The transport is exercised end to end against a real agent over a real socket — handshake refusals, cancellation, process streaming, protocol violations, a client that resets its connection, and a client that leaves mid-call — and against a scripted peer for the answers no real agent produces.

The `connector-execution-world` headless snapshot boots the shipped one-shot application with its execution world on a connector and pins the assembled transcript: the target block in the request, the bash call routed through the connector operation set, and the target's file content in the answer. It runs the in-process host, because a remote target answers the same operation set and the transcript cannot tell them apart.

## Alternatives considered

**Keep the binding in memory, seeded at agent creation.** Rejected because a conversation's target machine is part of what the conversation is. An in-memory map is lost on restart and invisible to replay, so a resumed session would silently run on the deployment default — a different machine than the transcript describes.

**Make the connector a deployment-wide singleton, as E2B is.** Rejected because the stated requirement is that a user configures connectors and then starts a conversation on one. A singleton would need a whole harness process per target.

**SSH as the transport, driving `sftp` and remote shells.** Rejected because it buys credential handling and encryption at the cost of reimplementing every filesystem operation as remote shell text — losing atomic publication, version guards, and typed errors — and because its Windows story is an OpenSSH server the operator may not have. An `ssh -L` tunnel in front of the TCP agent keeps the encryption and the credentials without moving the operation set onto a shell.

**JSON-RPC over WebSocket.** Rejected because it adds an HTTP upgrade and a framing dependency on both sides for no property this seam needs. Nothing here is a browser, and the same tunnel works either way.

**A single generic `RemoteExecution` service instead of a registry of connectors.** Rejected because it collapses the two things that differ per target — which machine, and which OS dialect — into a provider identity, leaving no way for one deployment to offer a Linux builder and a Windows lab box at once.

**Reimplement filesystem and process operations in the agent instead of hosting the local providers.** Rejected on the deletion test: the second implementation would drift from the first in exactly the places that are hardest to test remotely — atomic rename, version identity, CRLF handling, tree termination — and would need its own Windows port.

**Serve terminals over the link too.** Deferred, not rejected. PTY allocation, foreground-group inspection, and terminal-session cleanup are a deep primitive whose faithful projection onto a wire protocol is a larger design than the rest of this seam combined. `spawnTerminal` reports `CONNECTOR_UNSUPPORTED` so a deployment that mounts a persistent-shell capability against a connector fails loudly instead of silently running the shell on the wrong machine.

**Spill collected output to a file on the target and report its path.** Deferred. `dsh-tool-bash` surfaces a spill path to the model as the location of the complete stream, and a path on the target is not one the harness can read back. Bounded in-memory tails with honest truncation reporting are the smaller correct answer until a fetch operation exists.
