# Agent Note: The plugin marketplace is a catalog over profile bundles

Status: implemented

English | [中文](2026-08-26-plugin-marketplace-catalog-and-install.zh.md)

## Problem

[Profile plugin bundles](../architecture/2026-08-05-profile-plugin-bundles.md) made an out-of-tree plugin installable: an npm package declaring `dsh.bundle` becomes a patch layer in `$DSH_HOME/profiles/<name>`, and `dsh plugin --profile <name> add <package>` forwards to pnpm and reconciles the layer list. That answers "how does a package get in" and nothing else. There is no way to find out which packages exist, no metadata a person can judge before installing one, no record of where an installed package came from, and no way to reach any of it except by typing a package specifier the person already knows.

## Decision

The marketplace is a catalog, an identity, and a trust display over the packaging format that already exists. A marketplace plugin is an ordinary profile bundle that also carries a `dsh.plugin` package.json section; there is no second packaging format, no marketplace-only manifest file, and no marketplace-only install path. Four packages under `packages/marketplace/` split the roles:

- [`plugin-manifest`](../../../../packages/marketplace/plugin-manifest/README.md) owns the `dsh.plugin` schemastery schema (`displayName`, `description`, `publisher`, optional `homepage`, and `capabilities`), the readers that validate it from a package directory or from a catalog record, and `DECLARED_CAPABILITIES_NOTICE`.
- [`plugin-install`](../../../../packages/marketplace/plugin-install/README.md) owns the install path itself, extracted from `apps/cli/src/plugin.ts`: `resolve(request): InstallSpec`, `install`, `uninstall`, `list`, and the raw `forward` the `dsh plugin` escape hatch still uses.
- [`plugin-registry`](../../../../packages/marketplace/plugin-registry/README.md) is the Service Definition `ctx.pluginRegistry`: a provider registry plus the shared `catalog` / `search` / `get` / `versions` / `updates` reads.
- [`plugin-registry-static`](../../../../packages/marketplace/plugin-registry-static/README.md) is the Service Provider over one static index JSON, reachable through the filesystem or HTTP.

`dsh marketplace --profile <name> [--index <path-or-url>] search|show|install|uninstall|list|updates` is the Consumer. It mounts `PluginRegistry` and the static provider in a bare Cordis context, so the command line reads the catalog through exactly the seam a settings surface reads it through, and it installs through `plugin-install`, so a catalog install and a hand-typed `dsh plugin add` leave identical profiles. `$DSH_MARKETPLACE_INDEX` supplies the index when `--index` is absent; neither present is a loud failure rather than a silent empty catalog.

### Installs are tarball-only

A `PluginRelease` names an absolute filesystem path or an `https:` URL of a packed npm tarball, and never a git ref. A git dependency runs the publisher's `prepare` script during installation, which pnpm 10 blocks until someone adds the exact package key under `allowBuilds` — an approval for a build script nobody has read, demanded at the moment a person is trying to install something. A packed tarball ships built files, so the install copies bytes and runs nothing. The `dsh plugin` escape hatch still accepts a git specifier and prints how to allowlist it; the marketplace path does not offer that choice.

### Declared capabilities are a claim, not a sandbox

`capabilities` records what the publisher says the plugin does: the tool names it registers, `none` | `read` | `write` for filesystem and network, and a subprocess boolean. Nothing reads these fields to restrict anything. An installed plugin mounts as a profile patch layer with the same authority as an in-box plugin, so `DECLARED_CAPABILITIES_NOTICE` — *Declared by the publisher and not enforced: an installed plugin runs with full harness authority regardless of what it declares* — lives in `plugin-manifest` and every surface that prints capabilities prints it. Putting the sentence in the schema package is what keeps a command line and a settings panel from drifting into two different promises about the same field.

### Provenance is the profile's record, not the package's claim

`install` writes `dsh.marketplace.installs` into the profile's own package.json, keyed by installed package name: the `origin` (`marketplace` or `tarball`), the resolved tarball location, the catalog version when there was one, and an `installedAt` timestamp. `uninstall` drops the entry and `list` reports it. Because the record belongs to the profile, an audit can still distinguish a catalog install from a hand-supplied file after the catalog itself has changed.

### An install takes effect at the next launch

The profile launcher reads `dsh.profile.bundles` once at boot and keeps only `cordis.patch.yml` live, so installing a bundle does not mount it in the running process. Every install result carries a `bundle` flag and the command line says so explicitly (`relaunch dsh --profile <name> to use it`). The same is true in reverse for uninstall.

## Spike conclusions

**S1 — a packed tarball installs into a clean profile with no prompt.** `pnpm pack` on the sample plugin, then `dsh marketplace install` into an empty `DSH_HOME`, initializes the profile from its template, installs the tarball, appends the package to `dsh.profile.bundles`, and exits successfully. No `prepare` script runs and pnpm never asks for an `allowBuilds` entry, because a packed tarball has no build step to block. The install completes in a few hundred milliseconds and needs no network for a filesystem tarball, which is why the package tests use real pnpm rather than a stub.

**S2 — the restart requirement is real and is stated everywhere it matters.** A `--dump-config` after an install shows the new `# == <package>` layer and its rows; a `dsh` process already running does not. The install result's `bundle` flag, the command line's closing line, the package READMEs, and the example README all say it.

## Alternatives considered

- **A dedicated marketplace package format** (a `dsh-plugin.json` or a tarball layout of its own): rejected because the harness already has exactly one thing a plugin can be — a bundle whose patch the profile launcher applies. A second format would need its own resolver, its own loader path, and its own reason to exist; a `dsh.plugin` section adds catalog metadata to the format that already works, and a package can carry it whether or not it is published anywhere.
- **A marketplace-specific install path** that fetches and unpacks by itself: rejected because it would produce a profile whose contents pnpm did not write, and every later `dsh plugin` operation in that profile would be reasoning about a lockfile that does not describe the tree. Going through the same `pnpm add` keeps one owner of the profile's `node_modules`.
- **Enforcing declared capabilities in v1**: rejected as a promise the runtime cannot keep. A patch layer mounts arbitrary Cordis plugins in the harness process; enforcement means a real capability-scoped plugin host, which is a much larger change than a catalog. Declaring them unenforced and saying so in one shared sentence is honest; a capabilities field that looks like a limit but is not would be worse than none.
- **Provider-side search and ranking**: rejected because each provider would then answer the same query differently and a merged catalog would have no defined order. Providers return their complete catalog; matching, ordering, version selection, and update detection live in the seam.
- **Caching the catalog in the seam**: rejected because a static index is a file someone edits or a git checkout someone pulls, and a cached copy answers with the state from before that edit. Providers own whatever caching they need; the seam resolves at call time.
- **A provider that reads a git remote directly**: deferred rather than rejected. A checked-out index file and an HTTP-served index file cover both deployment shapes with one document format; cloning inside the provider adds a working-copy lifecycle the seam would then own.
- **Extending `plugin-inventory` with provenance**: rejected for this change. That service projects Loader entries, whose module specifiers are the plugin modules a bundle's patch mounts, not the bundle package name a profile installed. Joining the two needs a mapping from patch rows back to their owning bundle, which is a Loader-side change rather than a marketplace one; `plugin-install`'s `list` reports provenance against the profile manifest, which is where the record actually lives.

## Testing

Package tests cover all four packages at full statement, branch, and function coverage on `src`, using real pnpm against temporary profile directories rather than a stubbed package manager. `apps/cli/tests/marketplace-install.e2e.ts` pins the whole flow through the CLI: pack the sample, search, show, install into a throwaway `DSH_HOME`, assert the profile manifest's `dsh.profile.bundles` and `dsh.marketplace.installs`, assert the installed layer appears in `--dump-config`, uninstall, and assert it is gone. `apps/cli/tests/marketplace.snapshot.ts` pins what a person actually reads: the keyless transcript of every verb run against the built CLI, including the capability line and its unenforced notice, the provenance `list` renders, and the composed layer `--dump-config` shows after the relaunch. Three families of value are normalized out of that transcript because this repository does not own them — the temporary home and catalog directories, the install timestamp, and the package manager's own progress block, which `install` and `uninstall` stream straight to stdout. The reject path is covered at both ends: an invalid `dsh.plugin` section fails `parsePluginSection` loud, and an invalid or wrong-version index document fails the static provider with the index path named.

## Consequences

- A person can find a plugin, read who published it and what it claims to do, install it, and later see where it came from — without leaving the command line and without knowing a package specifier in advance.
- `apps/cli/src/plugin.ts` is now a launcher-facts wrapper over `plugin-install`, so the marketplace and the escape hatch cannot diverge in how they treat a profile.
- The catalog is a JSON document someone maintains by hand. There is no publish pipeline, no signature, no hash check, and no publisher namespace, so trust in a listing rests entirely on trust in whoever owns the index file.
- Only pnpm installs, and only tarballs; a plugin that genuinely needs a build step cannot be published to a marketplace index.

## Deferred

The settings **Marketplace** tab (a Host Remote over `ctx.pluginRegistry` plus `plugin-install`, and a `settings.plugins.tab` occupant beside the plugin inventory tab) is not in this change, and one missing fact is why: a Host plugin cannot name the profile it is running in. `dsh --profile <name>` resolves the profile directory in the launcher and provides the tree only `ctx.cmdlineArgs` and the environment snapshot, so nothing inside a composed plugin knows which directory under `$DSH_HOME/profiles` an install should write. A gateway configured with a literal profile name in the web-app bundle's static patch would install into whatever name that patch happened to carry, not into the running profile — a silently wrong target, and the one failure mode this seam must not have. Exposing the running profile as a launcher-provided startup service, the way [the app-owned command line](../architecture/2026-08-06-app-owned-command-line.md) exposes invocation values, is the prerequisite, and it is a change to `packages/boot` rather than to the marketplace. A read-only tab was rejected as the intermediate step: a marketplace a person can browse but not install from teaches them the button is missing rather than that the operation is unavailable. The command line is the complete Consumer until then, and `apps/cli/tests/marketplace.snapshot.ts` is the assembled-application evidence for the flow. Signing, hash verification, a publish pipeline, and an online plugin editor are likewise out of scope.
