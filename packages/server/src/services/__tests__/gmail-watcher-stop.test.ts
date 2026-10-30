// A stop must cancel the pending first poll: startGmailWatcher schedules a
// 10 s one-shot poll that stopGmailWatcher must also clear, or a stop-then-start
// can run two first polls (and a stop alone can read the mailbox afterwards).
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { startGmailWatcher, stopGmailWatcher } from '../gmail-watcher.js';

const { listGoogleAccountViews } = vi.hoisted(() => ({ listGoogleAccountViews: vi.fn() }));

vi.mock('../../google/auth.js', () => ({ listGoogleAccountViews }));
vi.mock('../../google/client.js', () => ({
  googleRead: vi.fn(async () => { throw new Error('no network in tests'); }),
}));
vi.mock('../../db/connection.js', () => ({
  getDb: () => ({
    prepare: () => ({
      get: () => undefined,
      run: () => ({ changes: 0 }),
      all: () => [],
    }),
  }),
}));

const view = {
  id: 'acct-1',
  kind: 'agent' as const,
  connected: true,
  enabled: true,
  email: 'bot@example.com',
  watchEmail: true,
  services: { gmail: true },
};

describe('gmail watcher stop cancels the pending first poll', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    listGoogleAccountViews.mockReset();
    listGoogleAccountViews.mockReturnValue([view]);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('does not run the first poll after stop', async () => {
    startGmailWatcher();

    stopGmailWatcher();
    listGoogleAccountViews.mockClear();

    await vi.advanceTimersByTimeAsync(30_000);
    expect(listGoogleAccountViews).not.toHaveBeenCalled();
  });

  it('still runs the first poll when left running', async () => {
    startGmailWatcher();

    await vi.advanceTimersByTimeAsync(30_000);
    expect(listGoogleAccountViews).toHaveBeenCalled();

    stopGmailWatcher();
  });
});
