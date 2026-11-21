// An agent that answers another agent's question naming the thread by the short token it is shown in the
// marker lands its answer on the full thread: the question is no longer owed and the one replied reader sees it.
import { describe, it, expect, beforeEach, vi } from 'vitest';
import Database from 'better-sqlite3';

const mockDb = { current: null as Database.Database | null };
vi.mock('../../db/connection.js', () => ({ getDb: () => mockDb.current!, getDbPath: () => ':memory:' }));
vi.mock('../../gateway/ws.js', () => ({ broadcast: vi.fn(), stampPersistedRow: (e: unknown) => e }));
vi.mock('../runtime.js', () => ({
  getAgentRuntime: () => ({ handleMessage: async () => {}, isRunning: () => false }), stopAgent: () => {},
}));

import { runMigrations } from '../../db/migrations.js';
import { executeTool, toolResultOf } from '../tools/index.js';
import { agentRequests } from '../v2/owed.js';
import { repliedOnThread } from '../../memory/message-store.js';

const db = (): Database.Database => mockDb.current!;
const call = async (agentId: string, args: Record<string, unknown>) =>
  toolResultOf(await executeTool(agentId, { id: `tc-${Math.random()}`, name: 'send_to_agent', arguments: args }));
const threadsIn = (agentId: string): string[] => (db().prepare(
  'SELECT a2a_thread_id AS t FROM messages WHERE agent_id = ? AND a2a_thread_id IS NOT NULL ORDER BY rowid',
).all(agentId) as Array<{ t: string }>).map((r) => r.t);

beforeEach(() => {
  mockDb.current = new Database(':memory:');
  runMigrations(mockDb.current);
  db().prepare(`INSERT INTO agents (id, name, status, config)
    VALUES ('asker', 'Asker', 'idle', '{}'), ('answerer', 'Answerer', 'idle', '{}')`).run();
});

describe('a reply on the short thread token answers the request', () => {
  it('the answer lands on the full thread, the question is not owed, and the reader sees the reply', async () => {
    const asked = await call('asker', { agent: 'answerer', intent: 'QUESTION', payload: 'What is the figure?' });
    expect(asked.isError, asked.content).toBeFalsy();
    const [thread] = threadsIn('answerer');
    expect(agentRequests('answerer').map((r) => r.threadId)).toEqual([thread]);

    const answered = await call('answerer', { agent: 'asker', intent: 'ANSWER', thread_id: thread.slice(0, 8), payload: 'It is 42.' });
    expect(answered.isError, answered.content).toBeFalsy();
    expect(threadsIn('asker')).toContain(thread);
    expect(threadsIn('asker')).not.toContain(thread.slice(0, 8));
    expect(agentRequests('answerer')).toEqual([]);
    expect(repliedOnThread('answerer', 'asker', thread, 0)).toBe(true);
  });
});
