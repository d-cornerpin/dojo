// A helper's result that arrived while the agent was busy is served by the one clock once the run is over; a result
// a turn already served wakes nothing.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

vi.mock('../../../db/connection.js', async () => (await import('./helpers/reply-sender.js')).connectionMock());
vi.mock('../../../gateway/ws.js', () => ({ broadcast: () => {} }));
const wake = vi.hoisted(() => vi.fn(async () => 'ran'));
vi.mock('../../runtime.js', () => ({ getAgentRuntime: () => ({ handleMessage: wake }) }));

import { runMigrations } from '../../../db/migrations.js';
import { insertMessage } from '../../../memory/message-store.js';
import { activeRuns, lastRunEndedAt } from '../../shared-state.js';
import { armOwedClock } from '../owed.js';
import { freshReplyDb, testDb, AGENT } from './helpers/reply-sender.js';

let resultId = '';

beforeEach(() => {
  vi.useFakeTimers();
  freshReplyDb(runMigrations);
  wake.mockClear();
  activeRuns.add(AGENT);   // the result lands mid-turn
  resultId = insertMessage({
    agentId: AGENT, role: 'user', lane: 'a2a', sourceAgentId: 'agent-helper', a2aThreadId: 'thr-1',
    a2aIntent: 'DELIVERABLE', a2aRequiresResponse: true, content: '[A2A:DELIVERABLE thread:thr-1 from:Helper] the figures',
  }).id;
});
afterEach(() => { activeRuns.delete(AGENT); lastRunEndedAt.delete(AGENT); vi.useRealTimers(); });

describe('a helper\'s result that arrived mid-turn is served after it', () => {
  it('the clock wakes the agent for it once the run has ended', async () => {
    armOwedClock();
    await vi.advanceTimersByTimeAsync(3_000);
    expect(wake).not.toHaveBeenCalled();
    activeRuns.delete(AGENT);
    armOwedClock();   // the run's end
    await vi.advanceTimersByTimeAsync(1_000);
    await vi.waitFor(() => expect(wake).toHaveBeenCalledWith(AGENT, ''));
  });

  it('a result a turn already served wakes nothing', async () => {
    activeRuns.delete(AGENT);
    testDb().prepare('UPDATE messages SET served_by_turn = 3 WHERE id = ?').run(resultId);
    armOwedClock();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(wake).not.toHaveBeenCalled();
  });
});
