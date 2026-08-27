#!/usr/bin/env node
/**
 * Entry of the downloadable single-file connector agent. It runs the same
 * program as the `dsh-connector-agent` bin; it exists as its own entry so the
 * self-contained build has a name of its own to emit, distinct from the bin a
 * workspace install links.
 * @module @deepseek-ai/dsh-connector-host/agent-bundle
 */

import './bin.ts'
