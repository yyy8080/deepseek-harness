import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { defineConfig } from 'tsdown'

const { version } = JSON.parse(
  readFileSync(new URL('package.json', import.meta.url), 'utf8'),
) as { version: string }

/**
 * Source text of the one `package.json` read that survives bundling: the LLM
 * package resolves its own version for the product attribution header. Nothing
 * sits beside a single downloaded file for that read to find, so the pass
 * inlines the version the build was cut from and fails if the emitted text ever
 * stops matching.
 */
const ATTRIBUTION_VERSION_READ = 'createRequire(import.meta.url)("../package.json")'

/**
 * The downloadable connector agent: one file a target machine runs with nothing
 * but Node installed.
 *
 * It differs from the ordinary `lib/bin.js` in two ways, both forced by the
 * target having no workspace, no registry access, and no install step. Every
 * `@deepseek-ai/*` dependency is inlined rather than imported. The two native
 * addons `dsh-subprocess-local` reaches for PTY terminals — `node-pty` and the
 * Windows inspector's `koffi` — cannot be inlined at all, so they resolve to
 * the `bundle-shims/` stand-ins, which throw if a terminal is ever requested.
 * The connector operation set serves files and one-shot commands and allocates
 * no terminal, so the agent never reaches them.
 *
 * This pass runs after the workspace lib bundles it inlines, so it is a
 * separate config invoked by `pnpm run build:connector-agent` rather than a
 * fourth entry of the package's ordinary build.
 */
export default defineConfig({
  entry: ['lib/types/agent-bundle.js'],
  outDir: 'lib',
  format: ['esm'],
  platform: 'node',
  target: 'es2024',
  fixedExtension: false,
  deps: {
    alwaysBundle: [/^@deepseek-ai\//],
  },
  inputOptions: {
    resolve: {
      alias: {
        'koffi': fileURLToPath(new URL('bundle-shims/koffi.js', import.meta.url)),
        'node-pty': fileURLToPath(new URL('bundle-shims/node-pty.js', import.meta.url)),
      },
    },
  },
  outputOptions: {
    codeSplitting: false,
    plugins: [{
      name: 'dsh-inline-attribution-version',
      renderChunk(code: string) {
        if (!code.includes(ATTRIBUTION_VERSION_READ)) {
          throw new Error(
            `connector agent bundle: expected ${ATTRIBUTION_VERSION_READ} in the emitted chunk; `
            + 'the attribution version read moved, so this inlining pass no longer covers it',
          )
        }
        return code.replaceAll(ATTRIBUTION_VERSION_READ, `({ version: ${JSON.stringify(version)} })`)
      },
    }],
  },
  dts: false,
  clean: false,
})
