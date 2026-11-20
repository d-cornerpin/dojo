// A wake queued in memory with no run behind it does not hide an owed agent from the clock; a live run does.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

vi.mock('../../../db/connection.js', async () => (await import('./helpers/reply-sender.js')).connectionMock());
vi.mock('../../../gateway/ws.js', () => ({ broadcast: () => {} }));
const wake = vi.hoisted(() => vi.fn(async () => 'ran'));
vi.mock('../../runtime.js', () => ({ getAgentRuntime: () => ({ handleMessage: wake }) }));

import { runMigrations } from '../../../db/migrations.js';
import { insertMessage } from '../../../memory/message-store.js';
import { activeRuns, lastRunEndedAt, pendingWakeups } from '../../shared-state.js';
import { armOwedClock } from '../owed.js';
import { freshReplyDb, AGENT } from './helpers/reply-sender.js';

beforeEach(() => {
  vi.useFakeTimers();
  freshReplyDb(runMigrations);
  insertMessage({ agentId: AGENT, role: 'user', content: 'are you there?', channel: 'dashboard' });
  wake.mockClear();
});
afterEach(() => { pendingWakeups.delete(AGENT); activeRuns.delete(AGENT); lastRunEndedAt.delete(AGENT); });

describe('a queued wake with no run does not hide the agent', () => {
  it('an owed agent with only a queued wake is woken', async () => {
    pendingWakeups.add(AGENT);
    armOwedClock();
    await vi.advanceTimersByTimeAsync(1_000);
    await vi.waitFor(() => expect(wake).toHaveBeenCalledWith(AGENT, ''));
  });

  it('an agent whose run is live is not woken by the clock', async () => {
    activeRuns.add(AGENT);
    armOwedClock();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(wake).not.toHaveBeenCalled();
  });

  it('an agent whose run is still unwinding is not woken, and is woken after the grace', async () => {
    lastRunEndedAt.set(AGENT, Date.now());
    armOwedClock();
    for (let i = 0; i < 15; i++) await vi.advanceTimersByTimeAsync(100);
    expect(wake).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(2_000);
    await vi.waitFor(() => expect(wake).toHaveBeenCalledWith(AGENT, ''));
  });
});
