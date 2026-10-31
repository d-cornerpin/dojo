// The watcher panel polls getWatcherStatus every 30 s. A failed refresh kept
// the old data and hid the error (the error stub only rendered when there was
// no data at all), so once one load had worked every later failure was
// invisible: the cards went on saying "Healthy" with a stale "Last poll" while
// the box was unreachable. A failed refresh now keeps the cards AND adds a
// one-line notice above them, naming the age of the last good answer; a later
// good refresh clears the notice.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, act } from '@testing-library/react';

vi.mock('../lib/api', async () => {
  const actual = await vi.importActual<Record<string, unknown>>('../lib/api');
  const stub: Record<string, unknown> = {};
  for (const key of Object.keys(actual)) {
    stub[key] = typeof actual[key] === 'function'
      ? vi.fn(async () => ({ ok: true, data: [] }))
      : actual[key];
  }
  return stub;
});

import * as api from '../lib/api';
import { WatcherCards } from '../components/WatcherCards';

const GMAIL: api.WatcherStatusDto = {
  name: 'gmail', running: true, enabled: true, connected: true,
  pollIntervalMs: 300_000, lastPollAt: '2026-01-01T00:00:00.000Z',
  lastPollOk: true, lastPollError: null, consecutiveFailures: 0,
  firstFailureAt: null, lastCheckedAt: '2026-01-01T00:00:00.000Z',
  totalPolls: 12, totalNotifications: 0, lastNotifiedAt: null,
  recentNotifications: [],
};
const off = (name: 'outlook' | 'teams'): api.WatcherStatusDto =>
  ({ ...GMAIL, name, enabled: false });
const WATCHERS: api.WatchersResponse = { gmail: GMAIL, outlook: off('outlook'), teams: off('teams') };

const getWatchers = () => vi.mocked(api).getWatcherStatus;

// shouldAdvanceTime lets testing-library's findBy/waitFor keep polling while
// the fake clock is otherwise frozen for us to step by hand.
beforeEach(() => { getWatchers().mockReset(); vi.useFakeTimers({ shouldAdvanceTime: true }); });
afterEach(() => { vi.useRealTimers(); vi.clearAllMocks(); });

const step = async (ms: number) => { await act(async () => { await vi.advanceTimersByTimeAsync(ms); }); };

describe('watcher cards after a failed refresh', () => {
  it('names the failure over the kept cards, and clears it on the next good refresh', async () => {
    getWatchers().mockResolvedValueOnce({ ok: true, data: WATCHERS });
    render(<WatcherCards />);
    await screen.findByText('Gmail');

    getWatchers().mockResolvedValueOnce({ ok: false, error: 'down' });
    await step(30_000);
    const notice = screen.getByText(/Could not refresh watcher status/);
    expect(notice.textContent).toContain('(showing the last answer from');
    expect(notice.textContent).toContain(': down');
    expect(screen.getByText('Gmail'), 'the failed refresh blanked the cards').toBeTruthy();

    getWatchers().mockResolvedValueOnce({ ok: true, data: WATCHERS });
    await step(30_000);
    await waitFor(() => expect(screen.queryByText(/Could not refresh watcher status/)).toBeNull());
    expect(screen.getByText('Gmail')).toBeTruthy();
  });
});
