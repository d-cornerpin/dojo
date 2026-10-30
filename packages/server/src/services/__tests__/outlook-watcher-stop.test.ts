// ════════════════════════════════════════════════════════════════════════════════════════
// outlook-watcher stop: stopping the watcher also cancels the pending first poll. The
// first poll is a one-shot setTimeout (10s) that has no handle; if stop only clears the
// interval, the pending first poll still fires and reads the mailbox through Microsoft
// Graph. Mirrors the Gmail brief (40) with Microsoft names.
// ════════════════════════════════════════════════════════════════════════════════════════

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { startOutlookWatcher, stopOutlookWatcher } from '../outlook-watcher.js';

const { listMicrosoftAccountViews } = vi.hoisted(() => ({ listMicrosoftAccountViews: vi.fn() }));
vi.mock('../../microsoft/auth.js', () => ({ listMicrosoftAccountViews }));
vi.mock('../../microsoft/client.js', () => ({
  msGraphRead: vi.fn(async () => { throw new Error('no network in tests'); }),
}));
vi.mock('../../db/connection.js', () => ({
  getDb: vi.fn(() => { throw new Error('no real DB in tests'); }),
  closeDb: vi.fn(),
  getDbPath: vi.fn(() => ''),
}));

const view = {
  id: 'acct-1',
  kind: 'agent',
  connected: true,
  enabled: true,
  email: 'bot@example.com',
  watchEmail: true,
  services: { outlook: true },
};

describe('outlook-watcher stop cancels the pending first poll', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    listMicrosoftAccountViews.mockReset();
    listMicrosoftAccountViews.mockReturnValue([view]);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('stop clears the pending first poll so it never fires', async () => {
    startOutlookWatcher();

    stopOutlookWatcher();

    listMicrosoftAccountViews.mockClear();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(listMicrosoftAccountViews).not.toHaveBeenCalled();
  });

  it('left running, the first poll still fires after 10s', async () => {
    startOutlookWatcher();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(listMicrosoftAccountViews).toHaveBeenCalled();
    stopOutlookWatcher();
  });
});
