// "Yes, go ahead" is work only as an answer to what the agent offered: the inbound question carries the agent's last
// reply in the same conversation as `previous_agent_message`, and leaves the field out when there is none.
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
import { inboundIsWork } from '../v2/classifiers/inbound-routing.js';
import { installDecisionModel, scriptDecisions, yes } from './decision-fake.js';
import { unfenceExternal } from '../../tools/external-content.js';

const row = (id: string, role: string, content: string, conv: string): void => {
  mockDb.current!.prepare("INSERT INTO messages (id, agent_id, role, content, conversation_id, created_at) VALUES (?, 'a1', ?, ?, ?, 0)").run(id, role, content, conv);
};
beforeEach(() => {
  mockDb.current = new Database(':memory:');
  runMigrations(mockDb.current);
  mockDb.current.pragma('foreign_keys = OFF');   // bare message rows, no agent or conversation rows
  installDecisionModel(mockDb.current);
});
afterEach(() => { vi.unstubAllGlobals(); mockDb.current?.close(); mockDb.current = null; });

describe('the inbound question reads the agent\'s last reply', () => {
  it('attaches the agent\'s message before the person\'s, from the same conversation only', async () => {
    row('m1', 'assistant', 'Want me to compare three movers and book the cheapest?', 'c1');
    row('m2', 'assistant', 'Unrelated reply elsewhere.', 'c2');
    row('m3', 'user', 'yes, go ahead', 'c1');
    const calls = scriptDecisions(() => yes(0.9));
    expect(await inboundIsWork({ root: { kind: 'ask', id: 'm3', sourceMessageId: 'm3', conversationId: 'c1' } }, 'a1', 'yes, go ahead')).toBe(true);
    const state = calls[0].state as Record<string, string>;
    expect(unfenceExternal(state.previous_agent_message)).toBe('Want me to compare three movers and book the cheapest?');
  });

  it('a first message carries no previous field', async () => {
    row('m1', 'user', 'hello', 'c1');
    const calls = scriptDecisions(() => yes(0.1));
    expect(await inboundIsWork({ root: { kind: 'ask', id: 'm1', sourceMessageId: 'm1', conversationId: 'c1' } }, 'a1', 'hello')).toBe(false);
    expect(Object.keys(calls[0].state as object)).toEqual(['message']);
  });
});
