# Agent Note: The connector download portal — a user enrolls their own machine from the browser

Status: implemented

English | [中文](2026-08-26-connector-download-portal.zh.md)

## Problem

The [connector execution-world decision](2026-08-26-connector-execution-world.md) made a target machine reachable, but only to an operator who already controls both ends. Putting a machine into the loop meant: install the package on the target, invent a token, start `dsh-connector-agent` bound to loopback, arrange an `ssh -L` tunnel or a private route from the harness to that port, and then write a `dsh-connector-tcp` declaration into the deployment's `cordis.yml` and restart it. Every one of those steps assumes shell access to the harness host and an inbound path to the target.

That is the wrong shape for the machine a product user actually wants to connect: their own laptop or workstation, behind NAT, with no fixed address, no inbound port, and no willingness to edit a deployment's YAML. It is also the wrong shape for the deployment, which must restart to learn about a target and cannot tell whether the machine named in its configuration is currently alive.

The product requirement was narrower and sharper: a visible entry in the Web UI, a real downloadable artifact per platform for Linux and Windows, and a path from download to a linked, verifiable connector with as few user steps as the security model allows.

## Decision

The deployment hands the target a script pre-addressed to itself, and the **target dials in**. Four choices carry that.

**Attachment is reversed, over an HTTP upgrade on the origin the browser is already using.** `dsh-connector-agent --attach <url>` issues an upgrade request for the `dsh-connector` protocol and is served over the socket it opened. The target then needs only outbound HTTP: no inbound port, no tunnel, no DNS name, no router change. Riding the deployment's existing origin rather than a second port means the reverse proxy, the TLS certificate, and the authentication already in front of the web UI are also in front of this, and one of them — the proxy — is the only piece an operator would otherwise have to configure twice.

The protocol itself does not change. The agent presents its enrollment token in the upgrade request, so the deployment knows which enrollment dialled before accepting a byte of protocol; the deployment then sends the same `hello` carrying the same secret, and the agent answers `ready`, exactly as over a dialled socket. Both directions stay authenticated and the served world is byte-identical either way, which is why `openConnectorLinkOverSocket` is the same code path for both transports.

**The artifact is a generated script, not an archive.** A target needs three facts — where to dial, which secret to present, and where to fetch the agent — and a script carries all three in the one file a user can run directly, with `curl … | bash` and the download button fetching identical bytes. An archive would add unpacking to the user's steps and a zip writer to ours, for nothing the three facts need. The script fetches the agent from the same deployment, so the target needs Node and nothing else: no registry access, no build step, no `node_modules`.

That requires the agent to be one file. `pnpm run build` emits `lib/agent-bundle.js`, and because native modules cannot travel in a single file, the bundle resolves `node-pty` and `koffi` to build-time stubs that throw when called. The consequence is exactly bounded: the bundle serves the filesystem and one-shot commands in full, and loses PTY allocation — which the connector operation set does not carry anyway — plus the Windows process inspector only terminal spawning uses.

**The unguessable download path is the credential, and the Remote that mints it is the authenticated surface.** `GET <basePath>/pack/<enrollmentId>` is gated by nothing but the 24-byte id in the path, because adding a second fence in front of the download would duplicate the web surface's authentication in a package that has no business knowing about it. Authentication lives where it already is: `issue` is a Typert Remote call through the authenticated gateway, so only a browser that is already inside can mint an enrollment.

**Enrollment separates two lifetimes.** The pack download expires — the file carries the secret, and a stale link in a shell history is the realistic leak — while the attachment it authorizes does not, so a target left running survives a sleeping laptop and a moving network without a new download. Each admitted attach owns a generation, so an adoption whose handshake finishes after a later dial was admitted, or after the enrollment was revoked, closes its own link instead of taking the slot the live agent holds.

**Enrollment, pack rendering, and attachment are one package.** They are the same fact at three moments: the secret minted for a download is the secret the agent presents, and the enrollment it names is the connector id registered in `ctx.connectors`. Splitting them would publish that secret across package interfaces and gain no independently evolving role, so `dsh-host-connector-portal` owns all three plus the `connectorPortal` Remote, and the browser half is the one client package `dsh-client-ui-settings-connectors`.

## Consequences

A deployment that mounts the portal accepts that anyone who can reach its authenticated browser surface can enroll a machine, and that anyone who obtains a pack before it expires can attach one. Both follow from what a connector is: complete read, write, and command access to the target, exercised by whoever controls the deployment. The generated script states this in its own header, in the file the user reads before running it, and the package README carries the threat model.

Reversed attachment does not remove the transport question, it moves it. Over `http:` the token and every frame travel in the clear, so a deployment reachable beyond a private network terminates TLS in front of the portal — the same fence its web UI already needs. Listen mode keeps its loopback default and its tunnel guidance untouched; nothing widens a bind implicitly.

The ledger is in memory. A harness restart drops every enrollment, and each agent's retry loop then reports a refused attachment until the user issues a new pack. That is the honest failure: a target that kept serving a deployment which no longer knows why would be worse than one that says it was refused.

Two workspace-wide facts changed. `socket.setEncoding` is gone from both `dsh-connector-tcp` and `dsh-connector-host`, replaced by a `StringDecoder` in the data handler, because Node forbids changing the encoding of a socket upgraded out of an HTTP request and the decoder keeps the multi-byte-safe boundary handling that call provided. And `dsh-connector` now owns the upgrade protocol name and the two request headers, since both halves of the reversed handshake read them.

## Verification

Package suites pin the enrollment ledger's four lifecycle states, its constant-time secret comparison, capacity accounting that lets a re-dial replace its own connection, and the generation bump on both re-admission and removal; pack rendering for both families, including the origin validation that refuses anything carrying more than a scheme and authority before it reaches a shell script; and origin derivation from forwarded headers.

The portal's own suite drives real HTTP against a real webserver: pack download and its expiry, the agent program route including its documented `503`, and the attach upgrade over raw sockets for the cases a client library cannot produce — a missing `Host`, an omitted token header, protocol bytes riding in the upgrade head, a wrong first frame, revocation mid-handshake, and two agents racing for one enrollment, where the generation guard is what makes the newest win. The agent's retry loop is exercised against refusals with and without a body, a transport error, and cancellation mid-dial.

Beyond the suites, the whole path was run end to end against a locally assembled web application: `issue` through the gateway, download, run the script, and read a real file on the target through the resulting connector link, then revoke and confirm the agent is disconnected and refused on re-dial.

## Alternatives considered

**Keep listen mode and ship tunnel instructions in the UI.** Rejected because it does not meet the requirement. Every remaining step — install, tunnel, YAML, restart — stays, and the two hardest for a product user, the inbound path and the deployment restart, are exactly the ones the reversed dial removes.

**Serve a zip or tarball containing the agent and a start script.** Rejected on the deletion test: an archive adds an unpack step for the user and an archive writer for us, and carries no fact the script does not already carry.

**Ship a compiled single-file executable per platform (`node --experimental-sea-config` or similar).** Deferred. It would remove the Node prerequisite, but it needs per-platform build hosts, signing on macOS and Windows, and a distribution size that turns the one-line install into a slow download. Requiring Node 22 is the smaller ask for the machines this targets.

**Put a token in the download URL's query string instead of its path.** Rejected because query strings are logged by proxies far more routinely than paths are, and the path segment is already unguessable.

**Authenticate the download route directly, reusing the API gateway's trust fence.** Rejected because the fence belongs to the client connection package and importing another plugin's symbols across that seam is not something a host package may do. Minting the id through the authenticated Remote puts the check where it already lives.

**Bind the session to a connector from this page.** Deferred, not rejected. The page reports each attached machine's connector id, and a session reaches it through an agent preset mounting the connector-backed providers. Choosing a target per conversation is a preset-composition question that belongs with the agent-preset UI, not with enrollment.

**Persist the enrollment ledger.** Deferred. It needs a store, a revocation story that survives restart, and a decision about what a pack still valid across a redeploy means. In-memory records with a visible refusal are the smaller correct answer until a deployment asks for the larger one.
