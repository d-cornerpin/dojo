// ════════════════════════════════════════════════════════════════════════════
// THE VITALS POLL LEAVES THE OWNER'S FILTERED LOG LIST ALONE.
//
// The Vitals page keeps its header tiles fresh by re-running its mount `load`
// on a steady 20-second interval. That same `load` also fetched the WHOLE log
// table (`getLogs(undefined, undefined, 100)`) and stored it, so twenty seconds
// after an owner filtered the log list down to, say, errors, the next poll
// silently refetched every line and dropped it back on top of the filtered view
// — the filter box still reads "Error" while the list behind it has quietly
// widened back to everything.
//
// The fix gives `load` a `withLogs` flag: the first load fetches logs, the poll
// refreshes health without touching the log list the owner (or the live
// `log:entry` feed) put there. What these two clauses pin:
//
//   · a poll adds NO unfiltered log fetch — the count of `getLogs` calls made
//     with no level filter does not grow across the tick the poll fires;
//   · the poll still refreshes health, so `withLogs` is narrow and did not
//     quietly switch off the tile refresh the interval exists for.
//
// `getLogs` answers by its first argument: no level filter → both a matching
// and a non-matching line; `'error'` → only the matching one.
// ════════════════════════════════════════════════════════════════════════════

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, act, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import type { ReactElement } from 'react';
import type { LogEntry } from '@dojo/shared';
import { resetFrames } from './helpers/frames';

vi.mock('../lib/api', async () => {
  const actual = await vi.importActual<Record<string, unknown>>('../lib/api');
  const stub: Record<string, unknown> = {};
  for (const key of Object.keys(actual)) {
    stub[key] = typeof actual[key] === 'function'
      ? vi.fn(async () => ({ ok: true, data: [] }))
      : actual[key];
  }
  stub.getToken = vi.fn(() => null);
  stub.clearToken = vi.fn(() => undefined);
  return stub;
});
vi.mock('../hooks/useWebSocket', async () => {
  const { fakeUseWebSocket } = await import('./helpers/frames');
  return { useWebSocket: fakeUseWebSocket, WebSocketProvider: ({ children }: { children: ReactElement }) => children };
});
vi.mock('../hooks/useToast', async () => {
  const { fakeToast } = await import('./helpers/frames');
  const stub = fakeToast();
  return {
    useToast: () => stub.value,
    ToastProvider: ({ children }: { children: ReactElement }) => children,
    ToastContainer: () => null,
  };
});

import * as api from '../lib/api';
import { Health } from '../pages/Health';
import { AuthProvider } from '../hooks/useAuth';
import { ActiveAgentProvider } from '../components/ActiveAgentProvider';
import { RightDockProvider } from '../components/RightDockProvider';
import { TechniqueSessionProvider } from '../components/TechniqueSessionProvider';
import { OrbProvider } from '../components/orb/OrbProvider';
import { ThemeProvider } from '../themes/ThemeProvider';

/** Same nesting App.tsx puts every page in; see `every-major-page-mounts.test.tsx`. */
const shell = (page: ReactElement) => (
  <MemoryRouter>
    <AuthProvider>
      <ThemeProvider>
        <OrbProvider>
          <ActiveAgentProvider>
            <RightDockProvider>
              <TechniqueSessionProvider>
                {page}
              </TechniqueSessionProvider>
            </RightDockProvider>
          </ActiveAgentProvider>
        </OrbProvider>
      </ThemeProvider>
    </AuthProvider>
  </MemoryRouter>
);

// One line the level filter keeps (error) and one it drops (info). The messages
// are the only place these words appear, so `getByText` names a specific row.
const KEPT: LogEntry = {
  timestamp: '2026-01-01T00:00:00.000Z', level: 'error', component: 'beta', message: 'beta line',
};
const DROPPED: LogEntry = {
  timestamp: '2026-01-01T00:00:01.000Z', level: 'info', component: 'alpha', message: 'alpha line',
};

// Shapes the render reads once loading clears (Health.tsx:323 reaches into
// resources.memory); the default `data: []` would throw there.
const HEALTH = { uptime: 3600, db: 'ok', agents: 3, memory: { used: 100, total: 1000 } };
const RESOURCES = { memory: { used: 100, total: 1000, percentage: 10 }, cpu: { usage: 5 }, ollama: null, ollamaLock: null };
const WATCHDOG = { running: true, lastHeartbeat: '2026-01-01T00:00:00.000Z', lastAlert: null };
const IM_BRIDGE = { enabled: false, connected: false };
// WatcherCards reads data.gmail.enabled etc. (WatcherCards.tsx:141); the default
// `data: []` has no .gmail and throws there once the fetch resolves. All three
// disabled → anyEnabled is false → the panel returns null.
const noWatcher = { enabled: false };
const WATCHERS = { gmail: noWatcher, outlook: noWatcher, teams: noWatcher };

/** `getLogs` calls made with NO level filter — the ones a poll must not add. */
const unfilteredLogFetches = () =>
  vi.mocked(api).getLogs.mock.calls.filter((call) => call[0] === undefined).length;

beforeEach(() => {
  resetFrames();

  vi.mocked(api).getLogs.mockImplementation((async (level?: string) => ({
    ok: true, data: level === 'error' ? [KEPT] : [DROPPED, KEPT],
  })) as unknown as typeof api.getLogs);
  vi.mocked(api).getHealth.mockImplementation(
    (async () => ({ ok: true, data: HEALTH })) as unknown as typeof api.getHealth);
  vi.mocked(api).getResources.mockImplementation(
    (async () => ({ ok: true, data: RESOURCES })) as unknown as typeof api.getResources);
  vi.mocked(api).getWatchdogStatus.mockImplementation(
    (async () => ({ ok: true, data: WATCHDOG })) as unknown as typeof api.getWatchdogStatus);
  vi.mocked(api).getIMBridgeStatus.mockImplementation(
    (async () => ({ ok: true, data: IM_BRIDGE })) as unknown as typeof api.getIMBridgeStatus);
  vi.mocked(api).getWatcherStatus.mockImplementation(
    (async () => ({ ok: true, data: WATCHERS })) as unknown as typeof api.getWatcherStatus);

  // shouldAdvanceTime lets testing-library's `findBy`/`waitFor` keep polling
  // while the fake clock is otherwise frozen for us to step by hand.
  vi.useFakeTimers({ shouldAdvanceTime: true });
});
afterEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
});

/**
 * Mounts Vitals, waits for the unfiltered load to draw both lines, filters to
 * errors (which drops the info line and refetches scoped to 'error'), then
 * advances the clock past one 20-second poll. Returns the count of unfiltered
 * log fetches taken just BEFORE the poll, the baseline the poll must not grow.
 */
async function mountFilterThenPoll(): Promise<{ unfilteredBeforePoll: number }> {
  render(shell(<Health />));
  await screen.findByText('beta line');

  // combobox[0] is the Level filter (the only selects on the page, Health.tsx:575).
  fireEvent.change(screen.getAllByRole('combobox')[0], { target: { value: 'error' } });
  await waitFor(() => {
    expect(api.getLogs).toHaveBeenCalledWith('error', undefined, 100);
    expect(screen.queryByText('alpha line')).toBeNull();
  });

  const unfilteredBeforePoll = unfilteredLogFetches();
  await act(async () => { await vi.advanceTimersByTimeAsync(21_000); }); // one 20 s poll, then slack
  return { unfilteredBeforePoll };
}

describe('the vitals poll leaves the log list alone', () => {
  it('a poll refetches no unfiltered log list and does not restore the dropped line', async () => {
    const { unfilteredBeforePoll } = await mountFilterThenPoll();
    const unfilteredAfterPoll = unfilteredLogFetches();

    expect(screen.queryByText('alpha line'), 'the poll restored a line the filter dropped').toBeNull();
    expect(
      unfilteredAfterPoll,
      `the poll re-fetched the unfiltered list (was ${unfilteredBeforePoll}, became ${unfilteredAfterPoll})`,
    ).toBe(unfilteredBeforePoll);
  });

  it('the poll still refreshes health', async () => {
    await mountFilterThenPoll();
    expect(
      vi.mocked(api).getHealth.mock.calls.length,
      'the poll stopped refreshing the health tiles it exists for',
    ).toBeGreaterThanOrEqual(2);
  });
});
