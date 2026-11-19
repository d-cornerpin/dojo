// One agent whose owed work cannot be read is logged and skipped: the clock still wakes every other agent owed something.
import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../../../db/connection.js', async () => (await import('./helpers/reply-sender.js')).connectionMock());
vi.mock('../../../gateway/ws.js', () => ({ broadcast: () => {} }));
const wake = vi.hoisted(() => vi.fn(async () => 'ran'));
vi.mock('../../runtime.js', () => ({ getAgentRuntime: () => ({ handleMessage: wake }) }));
vi.mock('../counterparty.js', async (orig) => {
  const real = await orig<typeof import('../counterparty.js')>();
  return {
    ...real,
    getWaitingHumanConversations: (agentId: string, opts?: { includeNotDue?: boolean }) => {
      if (agentId === 'agent-broken') throw new Error('this agent cannot be read');
      return real.getWaitingHumanConversations(agentId, opts);
    },
  };
});

import { runMigrations } from '../../../db/migrations.js';
import { insertMessage } from '../../../memory/message-store.js';
import { armOwedClock } from '../owed.js';
import { freshReplyDb, testDb, AGENT } from './helpers/reply-sender.js';

beforeEach(() => {
  vi.useFakeTimers();
  freshReplyDb(runMigrations);
  testDb().prepare("INSERT INTO agents (id, name, status, classification) VALUES ('agent-broken', 'agent-broken', 'idle', 'standard')").run();
  for (const id of ['agent-broken', AGENT]) insertMessage({ agentId: id, role: 'user', content: 'are you there?', channel: 'dashboard' });
  wake.mockClear();
});

describe("one agent's failed read does not stop the clock", () => {
  it('the readable agent is woken and the broken one is skipped', async () => {
    armOwedClock();
    await vi.advanceTimersByTimeAsync(1_000);
    await vi.waitFor(() => expect(wake).toHaveBeenCalledWith(AGENT, ''));
    expect(wake.mock.calls.map((c) => c[0])).not.toContain('agent-broken');
  });
});
