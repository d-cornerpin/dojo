// A run's end wakes the agent for the next owed item once, charging the wake budget once: twenty follow-up runs in
// a row stay well inside the budget of thirty in ten minutes.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

vi.mock('../../../db/connection.js', async () => (await import('./helpers/reply-sender.js')).connectionMock());
vi.mock('../../../gateway/ws.js', () => ({ broadcast: () => {} }));
const wake = vi.hoisted(() => vi.fn(async (_agentId: string, _content: string) => 'ran'));
vi.mock('../../runtime.js', () => ({ getAgentRuntime: () => ({ handleMessage: wake }) }));

import { runMigrations } from '../../../db/migrations.js';
import { insertMessage } from '../../../memory/message-store.js';
import { lastRunEndedAt } from '../../shared-state.js';
import { armOwedClock } from '../owed.js';
import { freshReplyDb, AGENT } from './helpers/reply-sender.js';

beforeEach(() => {
  vi.useFakeTimers();
  freshReplyDb(runMigrations);
  insertMessage({ agentId: AGENT, role: 'user', content: 'are you there?', channel: 'dashboard' });
  // Each woken run ends at once with the person still owed, the way a run's `finally` stamps and arms.
  wake.mockReset();
  wake.mockImplementation(async (id: string) => { lastRunEndedAt.set(id, Date.now()); armOwedClock(); return 'ran'; });
});
afterEach(() => { lastRunEndedAt.delete(AGENT); vi.useRealTimers(); });

describe('a run\'s end wakes the next owed item once', () => {
  it('twenty follow-up runs in a row do not trip the wake budget', async () => {
    lastRunEndedAt.set(AGENT, Date.now());
    armOwedClock();
    for (let i = 0; i < 120 && wake.mock.calls.length < 20; i++) await vi.advanceTimersByTimeAsync(500);
    expect(wake.mock.calls.length).toBe(20);
  });
});
