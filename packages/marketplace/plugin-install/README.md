# @deepseek-ai/dsh-plugin-install

English | [中文](README.zh.md)

The one path that puts a package into a `dsh --profile` composition, whether a marketplace surface, the `dsh marketplace` command line, or the raw `dsh plugin` escape hatch asks for it. Every operation ends in the same two steps — run pnpm in the profile directory under `$DSH_HOME/profiles`, then reconcile `dsh.profile.bundles` against what is actually installed — so a catalog install and a hand-typed one leave identical profiles.

`resolve(request)` turns an `InstallRequest` into an `InstallSpec`: it anchors a relative tarball path against the caller's working directory, resolves the profile directory, and builds the provenance to record. Defaulting happens there and nowhere else, so a caller can print or confirm what an install will do before it runs. `install(spec)` then runs the package manager, names the dependency the run installed under, reconciles the layer stack, and records provenance. `uninstall(target, id)` reverses it, `list(target)` reports a profile's out-of-tree dependencies with their versions, `dsh.plugin` metadata, and provenance, and `forward(target, args, cwd, warn)` hands raw pnpm arguments to the profile for operations the marketplace verbs do not cover.

Reconciliation keys on installed state rather than on a dependency diff: a dependency that resolves to a package declaring `dsh.bundle` joins `dsh.profile.bundles`, and one that no longer does — removed, or updated to a version that dropped the declaration — leaves it. In-box template bundles are not dependencies and are never touched. A newly added dependency that declares no bundle is installed as a plain dependency and reported through `warn`.

Provenance lives in the profile's own manifest under `dsh.marketplace.installs`, keyed by installed package name, and records the `origin` (`marketplace` or `tarball`), the resolved `tarball` location, the catalog `version` when there was one, and the `installedAt` timestamp. It is the profile's record of what it fetched, not the package's claim about itself, so a later audit can still tell a catalog install from a hand-supplied file after the catalog changes.

Installing does not change the running tree. The profile launcher reads `dsh.profile.bundles` once at boot and keeps only `cordis.patch.yml` live, so a newly installed layer mounts on the next launch — every install result says so through its `bundle` flag. Failures throw `PluginInstallError` with `PLUGIN_INSTALL_PACKAGE_MANAGER_MISSING`, `PLUGIN_INSTALL_FAILED`, `PLUGIN_INSTALL_NO_PACKAGE`, or `PLUGIN_INSTALL_NOT_INSTALLED`; a package-manager failure quotes pnpm's combined output, because pnpm prints several of its most common diagnostics to standard output rather than standard error.

## Model Experience

None, as this package installs packages into a profile directory and registers no prompt, tool, message, or provider request.

#### KV Cache effect

None; this package never assembles model input. A layer it installs mounts on the next launch, and whatever that layer registers owns its own effect.

## Known Limitations and Deferred Work

- **pnpm is the only package manager** — the executable name is fixed, and a host without pnpm on `PATH` fails with `PLUGIN_INSTALL_PACKAGE_MANAGER_MISSING`.
- **No integrity verification** — an install fetches whatever the tarball location holds; there is no hash, signature, or publisher attestation check, so trust rests entirely on the catalog and the transport.
- **No update operation** — installing a newer version over an older one is an ordinary install, and nothing here diffs versions or migrates a plugin's own state.
- **Reinstall of the installed version is identified by its recorded specifier** — the run moves no dependency, so a profile that already lists the same specifier under two names fails loud with `PLUGIN_INSTALL_NO_PACKAGE` rather than guessing which one the caller meant.
