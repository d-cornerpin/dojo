// ════════════════════════════════════════════════════════════════════════════════
// IMPORTING A MODULE MUST NOT HOLD AN EVENT LOOP OPEN.
// (t90 fix round 3b — the merge gate's `[vitest-worker]: Timeout calling "onTaskUpdate"`)
//
// ── WHAT HAPPENED ──
// `agent/runtime.ts` armed two `setInterval`s at MODULE SCOPE with no `.unref()`. A ref'd handle
// keeps an event loop alive, so merely IMPORTING the module left two 5-minute intervals in a
// vitest worker that nothing ever cleared — through that file's teardown and every file the worker
// ran afterwards. The full-suite run then exited 1 on a worker→main RPC that went unanswered
// inside vitest's 60 s birpc deadline (`vitest/dist/chunks/index.*.js`: `DEFAULT_TIMEOUT = 6e4`).
// Nothing failed; the run merely was not clean, which is worse — a green suite carrying an
// unhandled error is a suite nobody can read.
//
// Production never saw it: the server's listening socket holds its loop open, so an unref'd
// interval fires on exactly the cadence it always did. Only a short-lived importer notices.
//
// ── WHY THIS FILE IS SHAPED THIS WAY ──
// The first cut of §2 compared `process.getActiveResourcesInfo()` before and after the import and
// asserted the delta was zero. ⛔ IT WAS A COIN FLIP AND THE MUTANT PROVED IT: with one `.unref()`
// removed the clause stayed GREEN, because the import takes >12 s and vitest's own ref'd timers
// come and go inside that window, so a global snapshot delta measures the harness as much as the
// module. The property is not "the global count did not move" — it is "every interval this module
// armed was unref'd", so §2 now INTERCEPTS `setInterval` across the import and asks each armed
// timer directly. §1 is the control: it proves the interceptor classifies a ref'd and an unref'd
// interval correctly, in the same clause, so §2's answer is relative to a measured instrument
// rather than to a magic number.
// ════════════════════════════════════════════════════════════════════════════════

import { describe, it, expect } from 'vitest';

interface Armed { unrefd: boolean; timer: ReturnType<typeof setInterval> }

/**
 * Replace `setInterval` with a recorder for the duration of `body`, and report every interval
 * armed while it ran — each tagged with whether `.unref()` was called on it.
 *
 * The real timer is still created (the module under test must initialise exactly as it does in
 * production), and every one is cleared afterwards so this clause cannot leak the very kind of
 * handle it exists to catch.
 */
async function intervalsArmedDuring(body: () => Promise<unknown>): Promise<Armed[]> {
  const armed: Armed[] = [];
  const realSetInterval = globalThis.setInterval;
  globalThis.setInterval = ((handler: TimerHandler, ms?: number, ...rest: unknown[]) => {
    const timer = (realSetInterval as (...a: never[]) => ReturnType<typeof setInterval>)(
      handler as never, ms as never, ...(rest as never[]),
    );
    const record: Armed = { unrefd: false, timer };
    armed.push(record);
    const realUnref = timer.unref?.bind(timer);
    (timer as { unref?: () => unknown }).unref = (): unknown => {
      record.unrefd = true;
      return realUnref?.();
    };
    return timer;
  }) as typeof globalThis.setInterval;
  try {
    await body();
  } finally {
    globalThis.setInterval = realSetInterval;
    for (const a of armed) clearInterval(a.timer);
  }
  return armed;
}

describe('§1 the interceptor, before it is trusted', () => {
  it('⚠ it tells a ref\'d interval from an unref\'d one — otherwise §2 proves nothing', async () => {
    const armed = await intervalsArmedDuring(async () => {
      setInterval(() => { /* never fires: cleared by the helper */ }, 60_000);
      const quiet = setInterval(() => { /* never fires: cleared by the helper */ }, 60_000);
      quiet.unref?.();
    });

    expect(armed.length, 'both intervals must have been seen').toBe(2);
    expect(armed[0].unrefd, 'the first was left ref\'d and must be reported as such').toBe(false);
    expect(armed[1].unrefd, 'the second was unref\'d and must be reported as such').toBe(true);

    // And the second instrument, measured instantaneously so the harness cannot drift under it:
    // `getActiveResourcesInfo` reports what HOLDS the loop, so an unref'd timer is absent from it.
    const refd = (): number => process.getActiveResourcesInfo().filter((r) => r === 'Timeout').length;
    const control = refd();
    const kept = setInterval(() => { /* never fires */ }, 60_000);
    expect(refd(), 'a ref\'d interval holds the loop').toBe(control + 1);
    clearInterval(kept);
    const ignored = setInterval(() => { /* never fires */ }, 60_000);
    ignored.unref?.();
    expect(refd(), 'an unref\'d one does not — the fix\'s whole premise').toBe(control);
    clearInterval(ignored);
  });
});

describe('§2 agent/runtime.ts', () => {
  it('⚠ THE CLAUSE: every interval it arms at import is unref\'d, and it still arms them',
    async () => {
      const armed = await intervalsArmedDuring(() => import('../runtime.js'));

      // Counted BOTH ways (campaign wire rule). Deleting the sweeps would make "all unref'd"
      // vacuously true, and the sweeps are wanted behaviour — the stuck-agent recovery and the
      // orphaned-model repair, both on `STUCK_AGENT_CHECK_MS`. So their presence is asserted too.
      expect(armed.length, 'the module must still arm its two module-scope sweeps at import')
        .toBeGreaterThanOrEqual(2);

      const refd = armed.filter((a) => !a.unrefd);
      expect(refd.length, `importing agent/runtime.ts armed ${refd.length} ref'd interval(s) that `
        + 'nothing ever clears, so every worker reaching it keeps an event loop alive through its '
        + 'own teardown and the rest of the run: a module-scope setInterval needs .unref?.() '
        + '(the convention this file already follows at :1503 and :1550)')
        .toBe(0);
    });
});
