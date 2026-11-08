// The serve boundary retires a queued wake only when its work is spent: the task finished, or its
// schedule is paused. A held task (paused or blocked) is still the worker's, so its wake is served.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';

const mockDb = { current: null as Database.Database | null };
vi.mock('../../../db/connection.js', () => ({
  getDb: () => {
    if (!mockDb.current) throw new Error('test DB not initialized');
    return mockDb.current;
  },
  getDbPath: () => ':memory:',
}));
vi.mock('../../../gateway/ws.js', () => ({ broadcast: () => undefined, stampPersistedRow: (e: unknown) => e }));

import { runMigrations } from '../../../db/migrations.js';
import { insertEngineEventIfAbsent } from '../../../memory/message-store.js';
import { setHold } from '../../../work/done/hold.js';
import { retireSpentEngineEvents } from '../counterparty.js';

const AGENT = 'worker';

beforeEach(() => {
  mockDb.current = new Database(':memory:');
  runMigrations();
  mockDb.current.prepare("INSERT INTO agents (id, name, status) VALUES (?, 'Worker', 'idle')").run(AGENT);
});
afterEach(() => { mockDb.current?.close(); mockDb.current = null; });

function taskWithWake(id: string, isPaused = 0): void {
  const at = Date.now();
  mockDb.current!.prepare(
    `INSERT INTO work (id, kind, agent_id, requester, root_kind, root_id, state, intent, wakes, closes_thread, title, is_paused, opened_at, updated_at)
     VALUES (?, 'task', ?, 'owner', 'tracker', ?, 'claimed', 'task', 1, 0, 'Write the report', ?, ?, ?)`,
  ).run(id, AGENT, id, isPaused, at, at);
  insertEngineEventIfAbsent({
    id: `wake-${id}`, agentId: AGENT, content: '[Engine] continue the report', sourceAgentId: null, originIntent: 'scheduler_run',
    work: { taskId: id, runId: null, rootKind: 'task', rootId: id },
  });
}

const swept = (id: string): boolean =>
  !!(mockDb.current!.prepare('SELECT swept_at FROM messages WHERE id = ?').get(`wake-${id}`) as { swept_at: unknown }).swept_at;

describe('a hold never makes queued work spent', () => {
  it('a wake naming a held task is served, one naming a schedule-paused task is dropped', () => {
    taskWithWake('t-paused-hold');
    expect(setHold('t-paused-hold', 'paused', 'waiting on the owner to reply', 'engine').ok).toBe(true);
    taskWithWake('t-blocked-hold');
    expect(setHold('t-blocked-hold', 'blocked', 'need the vendor key', AGENT).ok).toBe(true);
    taskWithWake('t-schedule-paused', 1);

    expect(retireSpentEngineEvents(AGENT)).toBe(1);
    expect(swept('t-paused-hold')).toBe(false);
    expect(swept('t-blocked-hold')).toBe(false);
    expect(swept('t-schedule-paused')).toBe(true);
  });
});
