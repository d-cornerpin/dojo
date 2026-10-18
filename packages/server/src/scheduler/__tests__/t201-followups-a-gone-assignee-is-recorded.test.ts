// ════════════════════════════════════════════════════════════════════════════════════════
// t201 follow-up 3 — THE SCHEDULER RECORDS WHEN IT MOVES A FIRE OFF A GONE ASSIGNEE.
//
// When a scheduled task fires and its assignee has been terminated, the scheduler runs the
// occurrence on the main agent instead. That was a quiet fallback: a log line, and a task-log
// entry that said "assigned to <main agent>" with no word on who it had been. It now files the
// same record `moveAssignee` files: the cause (`assignee_gone`), who did it, from and to.
// ════════════════════════════════════════════════════════════════════════════════════════
import { describe, it, expect, beforeEach, vi } from 'vitest';
import Database from 'better-sqlite3';

const mockDb = { current: null as Database.Database | null };

vi.mock('../../db/connection.js', () => ({
  getDb: () => {
    if (!mockDb.current) throw new Error('test DB not initialized');
    return mockDb.current;
  },
}));
vi.mock('../../gateway/ws.js', () => ({ broadcast: () => { /* no-op */ } }));
vi.mock('../../agent/runtime.js', () => ({ getAgentRuntime: () => ({ handleMessage: async () => { /* no-op */ } }) }));
vi.mock('../../agent/agent-bus.js', () => ({ sendAgentMessage: () => { /* no-op */ } }));
vi.mock('../../agent/agent-notice.js', () => ({ postAgentNotice: () => 'notice-id' }));
vi.mock('../../memory/message-store.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../memory/message-store.js')>()),
  insertEngineEventIfAbsent: () => null,
}));
vi.mock('../../config/platform.js', () => ({
  getPrimaryAgentId: () => 'primary',
  getPMAgentId: () => 'pm',
  getOwnerName: () => 'the owner',
  isPMAgent: (id: string) => id === 'pm',
  isPrimaryAgent: (id: string) => id === 'primary',
}));

import { checkScheduledTasks } from '../runner.js';
import { createWorkTable, seedTrackerTask } from '../../work/__tests__/work-fixture.js';

function applySchema(db: Database.Database): void {
  createWorkTable(db);
  db.exec(`
    CREATE TABLE IF NOT EXISTS agents (
      id TEXT PRIMARY KEY, name TEXT, status TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')), updated_at TEXT
    );
  `);
  db.prepare("INSERT INTO agents (id, name, status) VALUES ('primary', 'Main', 'idle')").run();
  db.prepare("INSERT INTO agents (id, name, status) VALUES ('gone-worker', 'Gone', 'terminated')").run();
  db.prepare("INSERT INTO agents (id, name, status) VALUES ('live-worker', 'Live', 'idle')").run();
}

const dueTask = (id: string, agentId: string): void => {
  seedTrackerTask(mockDb.current!, {
    id, title: 'a scheduled job', description: 'do it', status: 'on_deck', agentId,
    schedule_status: 'waiting', is_paused: 0, next_run_at: Date.now() - 5_000,
  });
};

const moves = (taskId: string) => (mockDb.current!.prepare(
  `SELECT actor, payload FROM work_events WHERE work_id = ? AND kind = 'audit' ORDER BY id`,
).all(taskId) as Array<{ actor: string; payload: string }>)
  .map((r) => ({ actor: r.actor, ...(JSON.parse(r.payload) as Record<string, string>) }))
  .filter((p) => p.entry_kind === 'reassignment');

const fired = (taskId: string): number => (mockDb.current!.prepare(
  `SELECT COUNT(*) AS n FROM work WHERE kind = 'occurrence' AND parent_id = ?`,
).get(taskId) as { n: number }).n;

beforeEach(() => {
  mockDb.current = new Database(':memory:');
  applySchema(mockDb.current);
});

describe('a fire moved off a terminated assignee leaves a record', () => {
  it('records the cause, the scheduler as the actor, the old holder and the new one', async () => {
    dueTask('sched-0001', 'gone-worker');
    await checkScheduledTasks();
    expect(fired('sched-0001'), 'control: the occurrence did fire').toBe(1);
    const recorded = moves('sched-0001');
    expect(recorded, 'the fire happened and the move is on the record, once').toHaveLength(1);
    expect(recorded[0]!.actor).toBe('scheduler');
    expect(recorded[0]!.reason).toContain('cause=assignee_gone');
    expect(recorded[0]!.action_taken).toContain('gone-worker');
    expect(recorded[0]!.action_taken).toContain('primary');
  });

  it('CONTROL: a fire on a live assignee records no move', async () => {
    dueTask('sched-0002', 'live-worker');
    await checkScheduledTasks();
    expect(fired('sched-0002'), 'control: the occurrence did fire').toBe(1);
    expect(moves('sched-0002')).toEqual([]);
  });
});
