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
    // ── WHY THESE TWO NUMBERS EXIST (backlog wave 1b item 3, 2026-09-26) ──────────────────
    // Until now this suite ran on vitest's DEFAULT 5,000ms per-test budget — a number nobody
    // in this repository ever chose, sized for tests that do arithmetic. These tests compile
    // module graphs, run migrations and walk the whole source tree inside the measured window.
    // MEASURED on this box: 20 full-suite runs at v3.2.0 produced 14 clause failures across
    // SEVEN files, every one of them `Test timed out in 5000ms`, all inside 2 of the 20 runs —
    // the box had a slow patch and the whole family went together:
    //
    //   credentials/a-credential-is-never-silently-overwritten  (3)  <- the ledgered one
    //   tracker/version-gap-reconcile (2) · migration/manifest-version (2)
    //   memory/prefix-lane-conformance (2) · agent/the-stop-button-stops-the-agent (2)
    //   agent/child-scope (2) · agent/a-declared-patience-turn-end-does-not-auto-redial (1)
    //
    // Not one of those is a product defect and not one is a slow test: the credential clause
    // that fails most often is three assertions on a schema object behind a FIRST cold
    // `await import('../tools.js')`, measured at 3.16-3.22s of the 5s on an IDLE box.
    //
    // SIXTEEN files had already worked around this privately with their own `vi.setConfig` —
    // 8 at 20s, 6 at 15s, 2 at 30s. That is one judgement being re-made sixteen times, and
    // every file that has not yet been bitten is one that has not yet been unlucky.
    //
    // A per-test timeout is a HANG DETECTOR, not a performance assertion — it exists so a
    // deadlocked test fails instead of hanging the run. 30s is ~9x the slowest legitimate cold
    // clause measured here and still reports a genuine hang inside one release-gate run.
    // Anything that needs to assert speed must assert it, not ride this default.
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
