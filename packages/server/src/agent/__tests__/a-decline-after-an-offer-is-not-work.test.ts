// A reply to the agent's offer is asked two things in one call: is it a job of several steps, and does it only decline,
// put off or acknowledge the offer. Work needs a yes to the first and a no to the second; an unanswered second
// question leaves the reply between the lines. A message with no previous reply is asked the first question alone.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';

const mockDb = { current: null as Database.Database | null };
vi.mock('../../db/connection.js', () => ({
  getDb: () => { if (!mockDb.current) throw new Error('test DB not initialized'); return mockDb.current; },
  getDbPath: () => ':memory:',
}));
vi.mock('../../gateway/ws.js', () => ({ broadcast: vi.fn(), stampPersistedRow: (e: unknown) => e }));

import { runMigrations } from '../../db/migrations.js';
import '../decision-ask.js';
import { __forgetResidencyForTests } from '../decide.js';
import { inboundIsWork } from '../v2/classifiers/inbound-routing.js';
import { installDecisionModel, scriptDecisions, yes } from './decision-fake.js';

const row = (id: string, role: string, content: string): void => {
  mockDb.current!.prepare("INSERT INTO messages (id, agent_id, role, content, conversation_id, created_at) VALUES (?, 'a1', ?, ?, 'c1', 0)").run(id, role, content);
};
const reply = (text: string): Promise<boolean | undefined> => {
  row('m1', 'assistant', 'Want me to compare three movers and book the cheapest?');
  row('m2', 'user', text);
  return inboundIsWork({ root: { kind: 'ask', id: 'm2', sourceMessageId: 'm2', conversationId: 'c1' } }, 'a1', text);
};

beforeEach(() => {
  mockDb.current = new Database(':memory:');
  runMigrations(mockDb.current);
  mockDb.current.pragma('foreign_keys = OFF');
  installDecisionModel(mockDb.current);
  __forgetResidencyForTests();
});
afterEach(() => { vi.unstubAllGlobals(); mockDb.current?.close(); mockDb.current = null; });

describe('a reply to an offer', () => {
  it('judged work and also a decline is not work, from one call carrying both questions', async () => {
    const calls = scriptDecisions(() => yes(0.9));
    expect(await reply('no leave it')).toBe(false);
    expect(calls).toHaveLength(1);
    expect(calls[0].questions.sort()).toEqual(['declined', 'needs_several_steps']);
  });

  it('judged work and not a decline is work', async () => {
    scriptDecisions((name) => yes(name === 'declined' ? 0.1 : 0.9));
    expect(await reply('yes go ahead')).toBe(true);
  });

  it('with the decline question unanswered, a work verdict is between the lines', async () => {
    scriptDecisions((name) => (name === 'declined' ? {} : yes(0.9)));
    expect(await reply('yes go ahead')).toBeUndefined();
  });
});

describe('a message with no previous reply', () => {
  it('is asked only whether it is a job of several steps', async () => {
    row('m2', 'user', 'Plan the move and book the van.');
    const calls = scriptDecisions(() => yes(0.9));
    expect(await inboundIsWork({ root: { kind: 'ask', id: 'm2', sourceMessageId: 'm2', conversationId: 'c1' } }, 'a1', 'Plan the move and book the van.')).toBe(true);
    expect(calls[0].questions).toEqual(['needs_several_steps']);
  });
});
