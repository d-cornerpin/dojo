// ════════════════════════════════════════════════════════════════════════════════════════
// 39 — the update checker's FIRST check outlives a stop.
//
// `startUpdateChecker()` arms two timers: the daily interval AND a one-shot 60 s first check.
// `stopUpdateChecker()` cleared only the interval, so after a stop (or stop-then-start) the
// first check still fired and called `refreshUpdateCache()` — and when that check failed the
// error was swallowed (`catch(() => { /* logged inside */ })`), while the interval path logs it
// with `logger.error(message, { error })`. Four clauses pin both defects are fixed.
//
// No real time, no network: timers are fake, and the route + logger are both mocked.
// ════════════════════════════════════════════════════════════════════════════════════════

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// Declared BEFORE the `vi.mock` factories, which are hoisted above the imports; the factories
// run at first import, by which point these are initialised. Same idiom as the logger capture
// in `a-stale-tool-manual-is-said-out-loud.test.ts`.
const refreshUpdateCache = vi.fn(async () => ({
  currentVersion: '1.0.0',
  latestVersion: '1.0.0',
  updateAvailable: false,
}));
const debug = vi.fn();
const info = vi.fn();
const warn = vi.fn();
const error = vi.fn();

// `refresh()` does a dynamic `import()` of the route, so the mock applies there.
vi.mock('../../gateway/routes/update.js', () => ({ refreshUpdateCache }));

vi.mock('../../logger.js', () => ({
  createLogger: () => ({ debug, info, warn, error }),
}));

beforeEach(() => {
  vi.useFakeTimers();
  vi.resetModules();
  vi.clearAllMocks();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('the update checker first check is cancelled by a stop', () => {
  it('1. start, advance 60 s: the first check runs once; then stop', async () => {
    const { startUpdateChecker, stopUpdateChecker } = await import('../update-checker.js');
    startUpdateChecker();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(refreshUpdateCache, 'the first check ran once').toHaveBeenCalledTimes(1);
    stopUpdateChecker();
  });

  it('2. start, stop immediately, advance 120 s: nothing fires', async () => {
    const { startUpdateChecker, stopUpdateChecker } = await import('../update-checker.js');
    startUpdateChecker();
    stopUpdateChecker();
    await vi.advanceTimersByTimeAsync(120_000);
    expect(refreshUpdateCache, 'a stopped checker must not run its first check').toHaveBeenCalledTimes(0);
  });

  it('3. start, stop: no timer is left pending', async () => {
    const { startUpdateChecker, stopUpdateChecker } = await import('../update-checker.js');
    startUpdateChecker();
    stopUpdateChecker();
    expect(vi.getTimerCount(), 'the first-check timer must be cleared too').toBe(0);
  });

  it('4. a first check that fails is logged, like the interval path', async () => {
    const { startUpdateChecker } = await import('../update-checker.js');
    refreshUpdateCache.mockRejectedValueOnce(new Error('offline'));
    startUpdateChecker();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(error, 'a failed first check must be logged').toHaveBeenCalledTimes(1);
  });
});
