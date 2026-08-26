# instance-runtimes

English | [中文](README.zh.md)

Every conversation runs in its own isolated harness runtime, and the browser reaches all of them through the one connection it already had. Creating a chat allocates a runtime; the conversation's shell, filesystem, and session log live inside it from its first event.

The pieces are the [instance seam](../../packages/instance/instance/README.md), its [local-process provider](../../packages/instance/instance-local-process/README.md), the [worker bundle](../../packages/bundle/worker/README.md) each runtime boots, and the [multiplexing gateway](../../packages/instance/instance-gateway/README.md) that routes between them.

## Run it

Build first: each runtime is a child process that boots this checkout's built `dsh`.

```sh
pnpm run build
pnpm dsh web --patch examples/instance-runtimes/cordis.yml
```

The browser interface answers on http://127.0.0.1:3082. `DEEPSEEK_API_KEY` is needed to drive a conversation, not to start the control plane.

Each new chat allocates a runtime under `$DSH_HOME/instances/<instanceId>/`, holding that runtime's own `home` (its `DSH_HOME`) and `workspace` (its working directory, and the only tree its shell tools reach). The runtimes stop with the control plane; their session logs stay behind for inspection.

## What to look for

Session ids are namespaced by runtime — `inst-1~session-…` — which is how one connection addresses conversations across many isolated stores. Two chats created in a row land on different runtimes and report different `cwd` values; commands run in one are invisible to the other.

`maxInstances: 4` caps the demo at four live runtimes. Set `placement: shared` in the overlay to put every conversation in one runtime instead, which trades isolation between conversations for a single cold start.
