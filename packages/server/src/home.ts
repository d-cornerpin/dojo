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
// ════════════════════════════════════════

import os from 'node:os';
import path from 'node:path';

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

  return os.homedir();
}

/** `~/.dojo`, and anything under it. Sugar over `homeDir()` — same contract. */
export function dojoDir(...segments: string[]): string {
  return path.join(homeDir(), '.dojo', ...segments);
}
