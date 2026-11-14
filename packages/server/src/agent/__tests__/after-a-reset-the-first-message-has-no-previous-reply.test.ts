// The inbound question reads the agent's previous reply from the current session only: after a reset, the first
// message is judged on its own, though the conversation still holds the agent's reply from before.
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

const HOUR = 3_600_000;
const row = (id: string, role: string, content: string, at: number): void => {
  mockDb.current!.prepare("INSERT INTO messages (id, agent_id, role, content, conversation_id, created_at) VALUES (?, 'a1', ?, ?, 'c1', ?)").run(id, role, content, at);
};
const judge = (id: string, text: string): Promise<boolean | undefined> =>
  inboundIsWork({ root: { kind: 'ask', id, sourceMessageId: id, conversationId: 'c1' } }, 'a1', text);

beforeEach(() => {
  mockDb.current = new Database(':memory:');
  runMigrations(mockDb.current);
  mockDb.current.pragma('foreign_keys = OFF');
  installDecisionModel(mockDb.current);
  __forgetResidencyForTests();
  mockDb.current.prepare("INSERT INTO agents (id, name) VALUES ('a1', 'Agent')").run();
});
afterEach(() => { vi.unstubAllGlobals(); mockDb.current?.close(); mockDb.current = null; });

describe('the previous reply is read from the current session', () => {
  it('after a reset, the first message is judged with no previous message', async () => {
    const now = Date.now();
    row('m1', 'assistant', 'Want me to plan the whole week of dinners?', now - 2 * HOUR);
    mockDb.current!.prepare("UPDATE agents SET session_started_at = datetime(?, 'unixepoch') WHERE id = 'a1'").run(Math.floor((now - HOUR) / 1000));
    row('m2', 'user', 'yes go ahead', now);
    const calls = scriptDecisions(() => yes(0.1));
    await judge('m2', 'yes go ahead');
    expect(Object.keys(calls[0].state as object)).toEqual(['message']);
    expect(calls[0].questions).toEqual(['needs_several_steps']);
  });

  it('a reply inside the session is still attached', async () => {
    const now = Date.now();
    mockDb.current!.prepare("UPDATE agents SET session_started_at = datetime(?, 'unixepoch') WHERE id = 'a1'").run(Math.floor((now - HOUR) / 1000));
    row('m1', 'assistant', 'Want me to plan the whole week of dinners?', now - 60_000);
    row('m2', 'user', 'yes go ahead', now);
    const calls = scriptDecisions(() => yes(0.1));
    await judge('m2', 'yes go ahead');
    expect(Object.keys(calls[0].state as object).sort()).toEqual(['message', 'previous_agent_message']);
  });
});
