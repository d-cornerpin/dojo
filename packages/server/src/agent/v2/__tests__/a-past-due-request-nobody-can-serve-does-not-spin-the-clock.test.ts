// A request that stays owed because nothing serves it does not spin the clock: a paused agent arms no timer at all,
// and an agent whose wakes change nothing is woken at most 30 times in ten minutes, then again once the window clears.
import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../../../db/connection.js', async () => (await import('./helpers/reply-sender.js')).connectionMock());
vi.mock('../../../gateway/ws.js', () => ({ broadcast: () => {} }));
const wake = vi.hoisted(() => vi.fn(async () => 'ran'));
vi.mock('../../runtime.js', () => ({ getAgentRuntime: () => ({ handleMessage: wake }) }));

import { runMigrations } from '../../../db/migrations.js';
import { insertMessage } from '../../../memory/message-store.js';
import { armOwedClock } from '../owed.js';
import { freshReplyDb, testDb, AGENT } from './helpers/reply-sender.js';

beforeEach(() => {
  vi.useFakeTimers();
  freshReplyDb(runMigrations);
  insertMessage({ agentId: AGENT, role: 'user', content: 'are you there?', channel: 'dashboard' });
  wake.mockClear();
});

describe('a past-due request nobody can serve does not spin the clock', () => {
  it('a paused agent arms no timer and is never woken', async () => {
    testDb().prepare("UPDATE agents SET status = 'paused' WHERE id = ?").run(AGENT);
    const before = vi.getTimerCount();
    armOwedClock();
    expect(vi.getTimerCount()).toBe(before);
    await vi.advanceTimersByTimeAsync(3_600_000);
    expect(wake).not.toHaveBeenCalled();
  });

  it('wakes that change nothing stop at the budget and resume when its window clears', async () => {
    armOwedClock();
    await vi.advanceTimersByTimeAsync(9 * 60_000);
    expect(wake).toHaveBeenCalledTimes(30);
    await vi.advanceTimersByTimeAsync(60_000 + 2_000);
    await vi.waitFor(() => expect(wake.mock.calls.length).toBeGreaterThan(30));
  });
});
