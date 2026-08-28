# @deepseek-ai/dsh-plugin-registry

English | [中文](README.zh.md)

Service Definition for the plugin-registry [capability seam](../../../docs/glossary.md#capability-seam). `PluginRegistry` registers as `ctx.pluginRegistry` and owns a provider registry over marketplace catalog sources plus the search, lookup, and update detection every consumer shares. [`plugin-registry-static`](../plugin-registry-static/README.md) is the shipped Service Provider; `dsh marketplace` and the settings marketplace tab are the Consumers.

A provider supplies its complete catalog and does no matching: ranking, version selection, and update detection live here so every source answers a query the same way. `registerProvider(provider)` registers one under its `id` and returns the disposer; a duplicate id fails loud rather than shadowing the registered source.

`catalog(signal)` merges every registered provider's rows into one id-keyed index and rejects a plugin id two providers both list, so an answer never depends on registration order. `search(query, signal)` matches a case-insensitive substring against the package name, display name, description, and publisher, ordered by package name so the same query returns the same order across runs. `get(id, signal)` looks one plugin up, `versions(id, signal)` returns its releases newest first, and `updates(installed, signal)` reports every installed plugin whose version differs from the catalog's newest release — an installed plugin no catalog lists is skipped, because a hand-installed tarball is not an error.

Every read resolves the catalog at call time. Providers own their own caching, so the seam holds no second copy that could disagree with a source someone just edited. Nothing here installs: a `PluginRelease` names a tarball, and [`plugin-install`](../plugin-install/README.md) is what puts it in a profile. A release never carries a git ref, because a git dependency would run the publisher's `prepare` script during installation.

Failures throw `PluginRegistryError` with `PLUGIN_REGISTRY_DUPLICATE_PROVIDER`, `PLUGIN_REGISTRY_UNAVAILABLE`, `PLUGIN_REGISTRY_DUPLICATE_LISTING`, `PLUGIN_REGISTRY_EMPTY_RELEASES`, or `PLUGIN_REGISTRY_UNKNOWN_PLUGIN`; a provider adds its own codes for source failures.

## Model Experience

None, as this catalog seam answers marketplace queries and registers no prompt, tool, message, or provider request.

#### KV Cache effect

None; this package never assembles model input.

## Known Limitations and Deferred Work

- **No usability predicate** — a registered source is one an operator configured, so a source that cannot be read fails the whole read naming what broke, rather than dropping out of the merge and returning a silently short catalog.
- **Version strings are compared for equality, never ordered** — `updates` reports any difference from the newest release, so a locally installed pre-release appears as an available update.
- **Release order is the provider's** — the seam trusts each provider's "newest first" ordering and does not sort or parse semver itself.
