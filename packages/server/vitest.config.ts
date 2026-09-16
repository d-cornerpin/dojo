// ════════════════════════════════════════
// THE TEST SUITE'S OWN HOME.
//
// ── WHY THIS FILE EXISTS ──
// Until now `npm test` in this package was a bare `vitest run` with NO config file
// anywhere in the repo: no setupFiles, no globalSetup, no HOME redirection. Every
// `~/.dojo` path resolved `os.homedir()` at module load, so the suite wrote into the
// DEVELOPER'S REAL HOME. On 2026-09-16 a single full-suite run put 369 migration
// boots, ~123,000 log lines and 30 share bundles into the owner's `~/.dojo`, and the
// logger's one-backup unlink-then-rename rotation destroyed the real server's log
// history in the process (see `src/home.ts` and `src/logger.ts`).
//
// ── WHAT IT DOES ──
// Picks ONE root directory per `vitest run`, hands it to every worker through
// `test.env`, and lets `vitest.setup.ts` carve a private home out of it inside each
// worker process. `vitest.global-setup.ts` creates the root and removes it when the
// run ends.
//
// The run root is computed HERE, in the main process, because this module is
// evaluated exactly once per run — a setup file is evaluated once per worker and
// could not agree with itself on a name.
//
// Set DOJO_TEST_HOME_ROOT yourself to pin the location (CI artifacts, a debugger).
// Set DOJO_TEST_HOME_KEEP=1 to leave the tree behind for inspection.
// ════════════════════════════════════════

import os from 'node:os';
import path from 'node:path';
import { defineConfig } from 'vitest/config';

const runRoot =
  process.env.DOJO_TEST_HOME_ROOT && process.env.DOJO_TEST_HOME_ROOT !== ''
    ? process.env.DOJO_TEST_HOME_ROOT
    : path.join(os.tmpdir(), 'dojo-test-homes', `run-${process.pid}-${Date.now().toString(36)}`);

// The global setup runs in THIS process and reads the same variable.
process.env.DOJO_TEST_HOME_ROOT = runRoot;

export default defineConfig({
  test: {
    globalSetup: ['./vitest.global-setup.ts'],
    setupFiles: ['./vitest.setup.ts'],
    // Injected into every worker before its setup file runs.
    env: { DOJO_TEST_HOME_ROOT: runRoot },
  },
});
