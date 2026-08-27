# @deepseek-ai/dsh-client-ui-settings-connectors

English | [中文](README.zh.md)

The **Connectors** page of Web Settings: the one place a user turns another machine into an execution target for this deployment. The browser plugin registers a localized `settings.section` contribution with id `connectors` through `ctx.slots.inject()`, so it follows locale changes and teardown without importing the section owner. Every read and write goes to the `connectorPortal` Remote through [`api-remotes`](../../api/remotes/README.md); the host half is [`host-connector-portal`](../../host/connector-portal/README.md).

Picking Linux, Windows, or macOS mints an enrollment and renders the two equivalent ways to start its agent: a copyable one-line command (`curl … | bash`, or `irm … | iex` on Windows) and a download link saving the same generated script as a file. Both fetch the identical script, so the two routes run the same code. Below them the page lists the machines that have dialled in, each with its status, and for an attached one its connector id and served working directory, next to a control that revokes the enrollment and disconnects its agent.

An attached machine carries the two actions that make it usable. **Test** completes a real round trip over its live link and reports the latency and the working directory the target itself resolved, or the portal's own actionable message when nothing answers; it re-reads the ledger afterwards, because a machine that stopped answering is no longer the "Connected" the row above it claims. **Start a chat here** creates a conversation bound to that connector, composed from the preset the portal named, with the target's working directory as its cwd, and selects it. That action appears only where a conversation flow is mounted and the portal reported the deployment able to bind a session; where it is mounted but the deployment cannot, the row says why instead of offering a button that would silently run on the harness machine.

The page polls the ledger every four seconds while it is open, so a machine the user just started appears without a reload; a manual refresh sits beside the list heading. Failure to mint, to read the ledger, to test a machine, or to start a conversation stays local to that row and is retryable. The origin and the clipboard are injected by the client plugin rather than read from globals, keeping the component a pure function of its props.

## Model Experience

None, as this package only drives a Host-owned enrollment ledger from browser Settings and registers nothing model-facing.

#### KV Cache effect

None; this package neither assembles nor sends a provider request.

## Known Limitations and Deferred Work

- **No workspace for a connector chat** — the conversation lands ungrouped, because a Workspace is a directory on the machine hosting this deployment while the connector chat's cwd is a directory in the target's own world.
- **Test results are not durable** — an outcome lives in the row that requested it and is gone on the next page open; the ledger keeps no probe history.
- **Fixed poll cadence** — the ledger refreshes on a page-owned interval with no live push, so a status change is visible within one poll rather than immediately.
- **One ticket at a time** — issuing a pack replaces the command and download link on screen; earlier tickets remain valid on the host but are no longer shown.
