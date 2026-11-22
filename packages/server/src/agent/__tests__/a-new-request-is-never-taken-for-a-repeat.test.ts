// A new request is never refused as a repeat on a guess: an ASSIGN that reads like the one before it gets its own
// thread and task when it names none, and is delivered on the same thread when it names that one; a task whose
// title shares most of its words with one just opened is opened. A note repeated on a thread is still held back.
import { describe, it, expect, beforeEach, vi } from 'vitest';
import Database from 'better-sqlite3';

const mockDb = { current: null as Database.Database | null };
vi.mock('../../db/connection.js', () => ({ getDb: () => mockDb.current!, getDbPath: () => ':memory:' }));
vi.mock('../../gateway/ws.js', () => ({ broadcast: vi.fn(), stampPersistedRow: (e: unknown) => e }));
vi.mock('../runtime.js', () => ({ getAgentRuntime: () => ({ handleMessage: async () => {}, isRunning: () => false }), stopAgent: () => {} }));
// Every text embeds the same: any two messages look like the same one to the similarity check.
vi.mock('../../memory/embeddings.js', () => ({ generateEmbedding: async () => new Float32Array([1, 0, 0, 0]), queueEmbedding: () => {} }));

import { runMigrations } from '../../db/migrations.js';
import { executeTool, toolResultOf } from '../tools/index.js';

const call = async (name: string, args: Record<string, unknown>) =>
  toolResultOf(await executeTool('main', { id: `tc-${Math.random()}`, name, arguments: args }));
const received = (intent: string): number => (mockDb.current!.prepare(
  "SELECT COUNT(*) AS n FROM messages WHERE agent_id = 'packer' AND a2a_intent = ?").get(intent) as { n: number }).n;

beforeEach(() => {
  mockDb.current = new Database(':memory:');
  runMigrations();
  mockDb.current.prepare("INSERT INTO agents (id, name, status, config) VALUES ('main', 'Main', 'idle', '{}'), ('packer', 'Packer', 'idle', '{}')").run();
});

describe('a new request is never taken for a repeat', () => {
  it('a second ASSIGN with no thread that reads like the first gets its own thread and its own task', async () => {
    const camping = await call('send_to_agent', { agent: 'packer', intent: 'ASSIGN', payload: 'Write a camping packing list.' });
    const ski = await call('send_to_agent', { agent: 'packer', intent: 'ASSIGN', payload: 'Write a ski packing list.' });
    expect([camping.isError, ski.isError], ski.content).toEqual([false, false]);
    const threads = mockDb.current!.prepare("SELECT DISTINCT a2a_thread_id AS t FROM messages WHERE agent_id = 'packer' AND a2a_intent = 'ASSIGN'").all();
    expect(threads).toHaveLength(2);
    expect(mockDb.current!.prepare("SELECT COUNT(DISTINCT a2a_thread_id) AS n FROM work WHERE kind = 'task' AND a2a_thread_id IS NOT NULL").get()).toEqual({ n: 2 });
  });

  it('a second ASSIGN on the same thread that reads like the first is delivered; a repeated note is not', async () => {
    const first = await call('send_to_agent', { agent: 'packer', intent: 'ASSIGN', payload: 'Write a camping packing list.' });
    const thread = (mockDb.current!.prepare("SELECT a2a_thread_id AS t FROM messages WHERE agent_id = 'packer'").get() as { t: string }).t;
    const second = await call('send_to_agent', { agent: 'packer', intent: 'ASSIGN', thread_id: thread, payload: 'Write a ski packing list.' });
    expect([first.isError, second.isError], second.content).toEqual([false, false]);
    expect(received('ASSIGN')).toBe(2);

    await call('send_to_agent', { agent: 'packer', intent: 'FYI', payload: 'The car leaves at nine.' });
    const noteThread = (mockDb.current!.prepare("SELECT a2a_thread_id AS t FROM messages WHERE agent_id = 'packer' AND a2a_intent = 'FYI'").get() as { t: string }).t;
    const again = await call('send_to_agent', { agent: 'packer', intent: 'FYI', thread_id: noteThread, payload: 'The car leaves at nine sharp.' });
    expect(again.content).toContain('too similar');
    expect(received('FYI')).toBe(1);
  });

  it('a task whose title shares most words with one just opened is opened', async () => {
    const camping = await call('work_open', { kind: 'task', title: 'Packer writes a camping list', goal: 'A camping list' });
    const ski = await call('work_open', { kind: 'task', title: 'Packer writes a ski list', goal: 'A ski list' });
    expect([camping.isError, ski.isError], ski.content).toEqual([false, false]);
    expect(mockDb.current!.prepare("SELECT COUNT(*) AS n FROM work WHERE kind = 'task'").get()).toEqual({ n: 2 });
  });
});
