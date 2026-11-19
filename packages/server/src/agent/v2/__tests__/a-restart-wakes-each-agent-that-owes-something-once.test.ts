// After a restart the one clock wakes each agent that owes something exactly once (its turn serves it); an agent
// that owes nothing, or one left in error, is not woken.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

vi.mock('../../../db/connection.js', async () => (await import('./helpers/reply-sender.js')).connectionMock());
vi.mock('../../../gateway/ws.js', () => ({ broadcast: () => {} }));
const wake = vi.hoisted(() => vi.fn(async (_agentId: string, _content: string) => 'ran'));
vi.mock('../../runtime.js', () => ({ getAgentRuntime: () => ({ handleMessage: wake }) }));

import { runMigrations } from '../../../db/migrations.js';
import { insertMessage, insertEngineEvent } from '../../../memory/message-store.js';
import { armOwedClock } from '../owed.js';
import { freshReplyDb, testDb, AGENT } from './helpers/reply-sender.js';

const SECOND = 'agent-second';
const IDLE = 'agent-idle';
const BROKEN = 'agent-broken';

beforeEach(() => {
  vi.useFakeTimers();
  freshReplyDb(runMigrations);
  const agent = testDb().prepare("INSERT INTO agents (id, name, status, classification) VALUES (?, ?, ?, 'standard')");
  agent.run(SECOND, SECOND, 'idle');
  agent.run(IDLE, IDLE, 'idle');
  agent.run(BROKEN, BROKEN, 'error');
  insertMessage({ agentId: AGENT, role: 'user', content: 'what is on today?', channel: 'dashboard' });
  insertEngineEvent({ agentId: SECOND, content: 'remind the owner to call back', originIntent: 'scheduler', work: null });
  insertMessage({ agentId: BROKEN, role: 'user', content: 'are you there?', channel: 'dashboard' });
  // A woken turn serves what it was woken for (its request closed, its event stamped).
  wake.mockImplementation(async (id: string) => {
    testDb().prepare("UPDATE work SET state = 'abandoned', closed_at = ? WHERE agent_id = ? AND kind = 'ask'").run(Date.now(), id);
    testDb().prepare("UPDATE messages SET served_by_turn = 1 WHERE agent_id = ? AND lane = 'events'").run(id);
    return 'ran';
  });
});
afterEach(() => { vi.useRealTimers(); });

describe('a restart wakes each agent that owes something once', () => {
  it('each owing agent is woken once; the others are not', async () => {
    armOwedClock();   // the boot arm
    await vi.advanceTimersByTimeAsync(30_000);
    const woken = wake.mock.calls.map((c) => c[0]).sort();
    expect(woken).toEqual([AGENT, SECOND].sort());
  });
});
