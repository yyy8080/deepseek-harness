# @deepseek-ai/dsh-worker

English | [中文](README.zh.md)

The isolated-runtime bundle: the browser surface's host half with the browser removed. One `/api` gateway on loopback, no frontend dist, no `dsh.client` roster, no URL line, no default-browser handoff. A control plane supervises the process and reaches it over that gateway; nothing here serves a person directly.

Boot it as the `worker` profile — `dsh --profile worker` composes `@deepseek-ai/dsh-base` under this patch layer. The [local-process instance provider](../../instance/instance-local-process/README.md) is what normally starts it.

## Contract

- The server binds `127.0.0.1` on an OS-assigned port and declares no trusted hosts, so the `/api` fence refuses every non-loopback `Host`. A worker is reachable only from its own machine, by its supervisor.
- Readiness is the instance seam's endpoint handshake. With `endpointFile` set — the provider passes it as `DSH_INSTANCE_ENDPOINT_FILE` — the plugin renames a complete `{"origin":"http://127.0.0.1:<port>"}` file into place after the whole Loader tree settles, so a supervisor never sees a half-mounted worker. Without it, the same origin is printed instead.
- A boot that fails, or a tree disposed while the boot is in flight, publishes nothing: the supervisor observes the process exit rather than a stale endpoint.
- Isolation is the worker's own `DSH_HOME` and working directory, both supplied by the supervisor. Session logs, storages, settings, and shell state never leave that tree.
- The bundle mounts no agent-preset roster. Sessions run the process-wide agent plane `@deepseek-ai/dsh-base` composes, so `session.create` carries no preset choice into a worker.

## Model Experience

### Direct consumer

#### What the model sees

One prompt section, `app:worker-surface`, stating that the runtime was allocated for this conversation alone and that its filesystem, harness home, session store, and shell state are private to it. The section exists so the model does not offer to inspect the user's machine, which it cannot reach. Turn it off with `surfaceContext: false` where the composition supplies its own orientation.

#### Token effect

One short fixed section per request, on the order of sixty tokens.

#### KV Cache effect

The section text is constant for the lifetime of the worker, so it never invalidates the request prefix.

## Known Limitations and Deferred Work

- No `api-remotes` row, so the Typert RPC surfaces the browser uses for goals, message feedback, and the plugin inventory are unavailable inside a worker. A control plane that proxies those surfaces must serve them from its own plane or add the row here.
- No agent-preset roster (see above). Per-conversation composition inside a worker needs the preset rows and the matching host-plane disables the web surface carries.
- Worker output goes wherever the supervisor's stdio disposition sends it; the bundle prints nothing but the unsupervised readiness line.
