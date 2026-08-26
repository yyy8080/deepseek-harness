# Marketplace example

English | [中文](README.zh.md)

A complete static plugin marketplace in two files: [`index.json`](index.json) is the catalog, and [`hello-plugin/`](hello-plugin) is the one plugin it lists. Use it to exercise `dsh marketplace` without a hosted catalog.

The catalog names its release's tarball by the filename `pnpm pack` produces, relative to the index. Pack the sample beside the index and the catalog resolves:

```sh
cd examples/marketplace/hello-plugin
pnpm pack --pack-destination ..
```

Then browse and install into a throwaway profile:

```sh
export DSH_HOME=$(mktemp -d)
pnpm dsh marketplace --profile demo --index examples/marketplace/index.json search hello
pnpm dsh marketplace --profile demo --index examples/marketplace/index.json show dsh-plugin-hello-marketplace
pnpm dsh marketplace --profile demo --index examples/marketplace/index.json install dsh-plugin-hello-marketplace
pnpm dsh --profile demo --dump-config
```

The dump ends with the `# == dsh-plugin-hello-marketplace` layer and its `hello-marketplace` row, which is what "installed" means: the profile mounts one more patch layer on its next launch. A running `dsh` does not pick the layer up — only `cordis.patch.yml` stays live.

`index.json` is the [static catalog provider's](../../packages/marketplace/plugin-registry-static/README.md) document format. `hello-plugin/package.json` shows both halves a marketplace plugin declares: `dsh.bundle` (the patch layer the profile launcher mounts) and `dsh.plugin` (the catalog metadata and the publisher's declared, unenforced capabilities).
