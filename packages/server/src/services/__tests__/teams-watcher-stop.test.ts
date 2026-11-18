// ════════════════════════════════════════════════════════════════════════════════════════
// A stop of the Teams watcher must ALSO cancel the pending first poll, not just the interval.
//
// THE MEASURED DEFECT. `startTeamsWatcher` schedules the initial poll with a bare `setTimeout`
// (no handle) at `teams-watcher.ts:430`. `stopTeamsWatcher` clears only `pollTimer`, so the
// first poll still fires 15s after a stop and calls Microsoft Graph — and a stop-then-start can
// leave TWO first polls pending. The stop must own the first-poll timer the way it owns the
// interval.
//
// Fake timers; no network and no real DB. `msGraphRead` rejects in every clause, so the only
// observable is whether it was CALLED at all — which is exactly what the pending first poll
// does, and exactly what the stop is supposed to prevent.
// ════════════════════════════════════════════════════════════════════════════════════════

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { startTeamsWatcher, stopTeamsWatcher } from '../teams-watcher.js';

const { msGraphRead } = vi.hoisted(() => ({ msGraphRead: vi.fn() }));
vi.mock('../../microsoft/client.js', () => ({ msGraphRead }));
vi.mock('../../microsoft/accounts.js', () => ({ getPrimaryMicrosoftAccount: () => ({ id: 'acct-1' }) }));
vi.mock('../../microsoft/auth.js', () => ({
  isMicrosoftEnabled: () => true,
  isMicrosoftConnected: () => true,
  getEnabledMsServices: () => ({ teams: true }),
}));
vi.mock('../../db/connection.js', () => ({
  getDb: () => ({
    prepare: () => ({ get: () => undefined, run: () => ({ changes: 0 }), all: () => [] }),
  }),
}));

describe('teams watcher stop cancels the pending first poll', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    msGraphRead.mockReset();
    msGraphRead.mockRejectedValue(new Error('no network in tests'));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('THE RED: after a stop, the first poll does not fire — nothing calls Graph', async () => {
    startTeamsWatcher();

    stopTeamsWatcher();

    await vi.advanceTimersByTimeAsync(30_000);

    expect(msGraphRead, 'a stopped watcher must not run its pending first poll').not.toHaveBeenCalled();
  });

  it('a left-running watcher still fires its first poll after 15s', async () => {
    startTeamsWatcher();

    await vi.advanceTimersByTimeAsync(15_000);

    expect(msGraphRead, 'the initial poll still happens when the watcher is left running').toHaveBeenCalled();

    stopTeamsWatcher();
  });
});
