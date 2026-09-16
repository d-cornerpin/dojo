// ════════════════════════════════════════
// THE ONE PLACE THIS PLATFORM DECIDES WHERE "HOME" IS.
//
// ── WHY THIS EXISTS ──
// Every `~/.dojo` path in the server used to call `os.homedir()` for itself —
// 111 call sites across 55 files, none of them overridable. `vitest run` ran with
// no config, no setup file and no HOME redirection, so the test suite resolved the
// OWNER'S REAL home and wrote there: on 2026-09-16 one full-suite run put 369
// migration boots and ~123,000 log lines into `~/.dojo`, and the logger's
// unlink-then-rename rotation (one backup, a PER-PROCESS 60s throttle, ~30 worker
// processes) deleted the real server's log history while it did so. The only
// durable record of what the server actually did was destroyed by its own tests.
//
// ── THE CONTRACT ──
//   DOJO_HOME unset  → `os.homedir()`, byte for byte. This is production, and
//                      nothing about it changes.
//   DOJO_HOME set    → that absolute path is home. This is how the test suite
//                      (packages/server/vitest.setup.ts) gives every worker
//                      process its own throwaway home.
//
// ── THE TRIPWIRE ──
// Inside a test run (VITEST, or NODE_ENV=test) with DOJO_HOME unset, this THROWS
// rather than hand back the real home. A test that reaches the owner's `~/.dojo`
// is not a test that should quietly pass; it is the defect above, years earlier.
// The static half of the same tripwire lives in
// `src/__tests__/tests-stay-home.test.ts`: it refuses any `os.homedir()` call in
// `packages/server/src` outside this file, because a call site that bypasses
// `homeDir()` bypasses everything written here.
// ════════════════════════════════════════

import os from 'node:os';
import path from 'node:path';

/** True when this process is a test run, by either of the two signals vitest sets. */
export function isTestRun(): boolean {
  return process.env.VITEST === 'true' || process.env.VITEST === '1' || process.env.NODE_ENV === 'test';
}

/**
 * The home directory every `~/.dojo` path in the server hangs off.
 *
 * Not cached: `DOJO_HOME` is process-scoped in practice (set once per worker), but
 * a handful of tests rebind it per case, and a cache would hand them a stale home
 * that looks like a passing test.
 */
export function homeDir(): string {
  const override = process.env.DOJO_HOME;
  if (override !== undefined && override !== '') {
    if (!path.isAbsolute(override)) {
      throw new Error(
        `DOJO_HOME must be an absolute path; got ${JSON.stringify(override)}. ` +
          'A relative home resolves differently in every process that reads it.',
      );
    }
    return override;
  }

  if (isTestRun()) {
    throw new Error(
      'REAL-HOME TRIPWIRE: something resolved the real home directory during a test run.\n' +
        "  os.homedir() would have returned the developer's actual account.\n" +
        '  Tests get their own throwaway home via DOJO_HOME, set by packages/server/vitest.setup.ts.\n' +
        '  DOJO_HOME is unset here, which means one of two things:\n' +
        '    1. this code ran outside the vitest setup (a script, a globalSetup, a spawned child\n' +
        '       process that did not inherit the env) — pass DOJO_HOME through to it; or\n' +
        '    2. a test deleted DOJO_HOME and did not restore it.\n' +
        '  This throw is deliberate. A full suite once wrote 369 migration boots and ~123,000 log\n' +
        "  lines into the owner's ~/.dojo and its log rotation deleted the real server's history.",
    );
  }

  return os.homedir();
}

/** `~/.dojo`, and anything under it. Sugar over `homeDir()` — same contract. */
export function dojoDir(...segments: string[]): string {
  return path.join(homeDir(), '.dojo', ...segments);
}
