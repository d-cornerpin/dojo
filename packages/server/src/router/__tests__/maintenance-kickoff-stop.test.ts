// The router maintenance loop's first-run must not outlive its stop.
//
// startRouterMaintenance arms two timers: a repeating 6-hour interval AND a
// one-shot "delayed first tick" (5 min) so the loop never piles onto a cold
// boot. stopRouterMaintenance must cancel BOTH. A loop stopped inside its first
// five minutes used to fire the delayed tick anyway — resetting the probe budget
// and possibly starting a router training it was told to stand down from.
//
// runCycle refreshes the probe budget first (regardless of gating), so a spy on
// resetProbeBudget counts how many cycles actually ran. The four collaborators
// are mocked so nothing touches a database; gating is off, so a cycle never
// reaches a train.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const resetProbeBudget = vi.hoisted(() => vi.fn());

vi.mock('../../db/connection.js', () => ({ getDb: () => { throw new Error('no db'); } }));
vi.mock('../gating.js', () => ({ isAutoRouterInUse: () => false }));
vi.mock('../labels.js', () => ({ countLabels: () => 0 }));
vi.mock('../probe.js', () => ({ resetProbeBudget: () => resetProbeBudget() }));

import { startRouterMaintenance, stopRouterMaintenance } from '../maintenance.js';

const KICKOFF_MS = 5 * 60 * 1000;        // the delayed first tick
const INTERVAL_MS = 6 * 60 * 60 * 1000;  // the repeating wake-up

beforeEach(() => {
  vi.useFakeTimers();
  resetProbeBudget.mockClear();
});
afterEach(() => {
  stopRouterMaintenance();
  vi.useRealTimers();
});

describe('the delayed first tick and its stop', () => {
  it('running: the delayed first tick fires', async () => {
    startRouterMaintenance();
    await vi.advanceTimersByTimeAsync(KICKOFF_MS + 10);
    expect(resetProbeBudget).toHaveBeenCalledTimes(1);
  });

  it('stopped before the first tick: nothing runs afterwards', async () => {
    startRouterMaintenance();
    stopRouterMaintenance();
    await vi.advanceTimersByTimeAsync(KICKOFF_MS + 10);
    expect(resetProbeBudget).not.toHaveBeenCalled();
  });

  it('stopped after a 6-hour tick: nothing ticks after the stop', async () => {
    startRouterMaintenance();
    await vi.advanceTimersByTimeAsync(INTERVAL_MS + 10); // first-run + one interval tick
    expect(resetProbeBudget).toHaveBeenCalledTimes(2);
    stopRouterMaintenance();
    await vi.advanceTimersByTimeAsync(13 * 60 * 60 * 1000);
    expect(resetProbeBudget).toHaveBeenCalledTimes(2);
  });

  it('a restart arms a fresh pair: only the new start ticks', async () => {
    startRouterMaintenance();
    stopRouterMaintenance();
    startRouterMaintenance();
    await vi.advanceTimersByTimeAsync(KICKOFF_MS + 10);
    expect(resetProbeBudget).toHaveBeenCalledTimes(1);
  });
});
