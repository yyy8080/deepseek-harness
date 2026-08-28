# @deepseek-ai/dsh-plugin-registry-static

English | [中文](README.zh.md)

Service Provider for [`plugin-registry`](../plugin-registry/README.md) over one static index document: a JSON file listing every plugin and its releases, reachable through the filesystem or over HTTP. That single document is the whole marketplace backend until a publish pipeline exists. The plugin registers under the provider id `static`.

Config: `index` is an `http(s):` URL, a `file:` URL, or a filesystem path, and `base` is the directory a relative `index` path resolves against, defaulting to the process working directory.

```yaml
- @deepseek-ai/dsh-plugin-registry
- @deepseek-ai/dsh-plugin-registry-static:
    index: ./examples/marketplace/index.json
```

The document declares `version: 1` and a `plugins` array. Each entry carries `id` (the npm package name) beside the `dsh.plugin` fields [`plugin-manifest`](../plugin-manifest/README.md) validates, plus a `releases` array of `{ version, tarball, publishedAt? }` ordered newest first. A relative `tarball` resolves against the index file, so a checked-in index and its packed tarballs move together; an absolute path stays as written, and an HTTP index resolves a relative tarball against its own URL. [`examples/marketplace/index.json`](../../../examples/marketplace/index.json) is a runnable document in this format.

The index is read on every catalog call. A static index is a file someone edits or a git checkout someone pulls, and a cache would answer with the copy from before that edit; the seam already resolves catalogs lazily, so the read happens once per user-visible operation. An HTTP read refuses redirects, because a redirect would move the catalog to an origin the operator did not configure, and it honors the seam's cancellation signal.

Failures throw the seam's `PluginRegistryError` with `PLUGIN_CATALOG_UNREADABLE` when the source cannot be read and `PLUGIN_CATALOG_INVALID` when the document, its version, one entry's manifest fields, or one entry's release list fails validation. Every message names the resolved index path or URL.

## Model Experience

None, as this catalog provider reads a JSON index and registers no prompt, tool, message, or provider request.

#### KV Cache effect

None; this package never assembles model input.

## Known Limitations and Deferred Work

- **Read-only** — there is no publish, sign, or index-writing path; the document is maintained by whoever owns the file or the git repository serving it.
- **One index per composition** — the provider id is fixed at `static`, so a second mount of this plugin fails with the seam's `PLUGIN_REGISTRY_DUPLICATE_PROVIDER`; serving several catalogs at once needs a configurable id or a second provider package.
- **Whole-document reads** — every call fetches and validates the complete index, so a large hosted catalog pays the full transfer and parse on each search.
