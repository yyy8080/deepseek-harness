# marketplace/ — plugin catalog, identity, and install

English | [中文](README.zh.md)

The marketplace group adds a catalog over the packaging format the harness already has. A marketplace plugin is an ordinary profile [bundle](../bundle/README.md) — an npm package whose manifest declares `dsh.bundle` — plus a `dsh.plugin` section carrying the display metadata and the publisher's declared capabilities. Nothing here introduces a second packaging format, and installing goes through the same profile path `dsh plugin add` takes, so a catalog install and a hand-typed one leave identical profiles under `$DSH_HOME/profiles`.

| Package | Role | ctx key |
|---|---|---|
| [`plugin-manifest/`](plugin-manifest/README.md) | The `dsh.plugin` schema and the readers that validate it | — (no service) |
| [`plugin-install/`](plugin-install/README.md) | Resolve, install, uninstall, and list a profile's plugins with provenance | — (no service) |
| [`plugin-registry/`](plugin-registry/README.md) | Service Definition for the catalog seam: search, lookup, versions, updates | `pluginRegistry` |
| [`plugin-registry-static/`](plugin-registry-static/README.md) | Service Provider reading one static index JSON from disk or HTTP | — (registers a provider) |

Installs are tarball-only. A git dependency runs the publisher's `prepare` script during installation, which the package manager blocks until someone allowlists a build they have not read; a packed tarball ships the built files, so the install copies bytes and runs nothing. [`examples/marketplace`](../../examples/marketplace/README.md) is a runnable index with one installable sample plugin.

Declared capabilities are a publisher's claim, not a sandbox. An installed plugin mounts as a profile patch layer with the same authority as an in-box plugin, so every surface that shows capabilities also shows `DECLARED_CAPABILITIES_NOTICE` from [`plugin-manifest`](plugin-manifest/README.md). The [marketplace Agent Note](../../.agents/notes/implemented/feature/2026-08-26-plugin-marketplace-catalog-and-install.md) records the design and the alternatives it rejected.
