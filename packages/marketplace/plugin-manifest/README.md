# @deepseek-ai/dsh-plugin-manifest

English | [中文](README.zh.md)

The `dsh.plugin` package.json section: its [schemastery](../../../vendor/schemastery) schema, the readers that validate it, and the one sentence every surface prints beside declared capabilities. A marketplace plugin is a profile [bundle](../../bundle/README.md) that also carries this section; the section supplies what a person needs to judge a listing — `displayName`, `description`, `publisher`, an optional `homepage`, and `capabilities`.

`capabilities` declares `tools` (the tool names the plugin registers), `filesystem` and `network` as `none` | `read` | `write`, and `subprocess` as a boolean. Every field is required, because a catalog row rendering a blank name or publisher is a row nobody can judge.

`parsePluginSection(value, source)` validates one section, `parsePluginManifest(value, source)` validates a whole record whose `id` travels beside the section fields — the form a catalog index embeds — and `readPluginManifest(packageDir)` reads and validates a package's own package.json. Both parsers project field by field rather than returning the validated input, so a catalog entry's release list cannot leak into plugin metadata. A package with no `dsh.plugin` section is not a marketplace plugin: `readPluginManifest` returns `undefined` instead of inventing metadata. Failures throw `PluginManifestError` with `PLUGIN_MANIFEST_INVALID`, `PLUGIN_MANIFEST_UNNAMED`, or `PLUGIN_MANIFEST_UNREADABLE`, always naming the file or catalog that carries the bad value.

`DECLARED_CAPABILITIES_NOTICE` is the shared wording: *Declared by the publisher and not enforced: an installed plugin runs with full harness authority regardless of what it declares.* It lives here so a command line and a settings panel cannot drift into two different promises about the same field.

## Model Experience

None, as this package only validates publisher metadata and registers no prompt, tool, message, or provider request.

#### KV Cache effect

None; this package never assembles model input.

## Known Limitations and Deferred Work

- **`capabilities` is a claim, not a limit** — nothing in the harness reads these fields to restrict an installed plugin, which mounts as a profile patch layer with full authority. A consumer that shows them must show `DECLARED_CAPABILITIES_NOTICE` too.
- **No publisher identity** — `publisher` is free text with no signature, namespace reservation, or provenance attestation behind it, so it identifies no one until a publish pipeline exists.
