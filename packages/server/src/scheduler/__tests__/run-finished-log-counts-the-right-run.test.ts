// The close-out line must count the run that just FINISHED, not one past it:
// onTaskRunComplete bumps the run counter (bumpWorkAttempts, `UPDATE work SET
// attempts = attempts + 1`) BEFORE re-reading the task row, so `task.run_count`
// already includes the run being closed out. The per-run audit line must use it
// as read — the same run's fire line says "scheduler fired run #N" for that N.
//
// The real writeTaskLog discards `transition` entries (task-log.ts:148), so this
// file reads what the close-out handed to that seam: writeTaskLog is stubbed to
// RECORD actionTaken. The DB/runner harness is copied from
// fallen-terminates.test.ts, which already calls the real onTaskRunComplete.

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
vi.mock('../../agent/agent-notice.js', () => ({
  postAgentNotice: () => 'notice-id',
}));
vi.mock('../../memory/message-store.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../memory/message-store.js')>()),
  insertEngineEventIfAbsent: () => null,
}));
vi.mock('../../config/platform.js', () => ({
  getPrimaryAgentId: () => 'primary',
  getPMAgentId: () => 'pm',
  getOwnerName: () => 'the owner',
}));
// The seam under test: record the action line the close-out wrote, keep the
// other exports real so every other task-log consumer still loads.
const actionsTaken: Array<string | null> = [];
vi.mock('../../tracker/task-log.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../tracker/task-log.js')>()),
  writeTaskLog: (input: { actionTaken?: string | null }) => {
    actionsTaken.push(input.actionTaken ?? null);
    return null;
  },
}));

import { onTaskRunComplete } from '../runner.js';
import { runMigrations } from '../../db/migrations.js';
import { seedTrackerTask, ms } from '../../work/__tests__/work-fixture.js';

/** A live scheduled row. Defaults to a recurring one (fires again); pass
 *  repeat_interval/repeat_unit/next_run_at nulls for a one-shot. */
function seedTask(db: Database.Database, overrides: Record<string, unknown> = {}): string {
  const id = `task-${Math.random().toString(36).slice(2, 10)}`;
  const future = new Date(Date.now() + 60 * 60 * 1000).toISOString();
  const cols: Record<string, unknown> = {
    id,
    title: 'daily brief',
    description: 'daily brief',
    status: 'in_progress',
    createdBy: 'primary',
    agentId: 'primary',
    projectId: null,
    repeat_interval: 1,
    repeat_unit: 'days',
    schedule_status: 'running',
    next_run_at: future,
    attempts: 0,
    task_kind: null,
    ...overrides,
  };
  const { status, createdBy, agentId, projectId, next_run_at: nextRunAt,
    ...rest } = cols as Record<string, any>;
  seedTrackerTask(db, {
    id, status: status as string, createdBy: createdBy as string,
    agentId: agentId as string, projectId: (projectId as string) ?? null,
    next_run_at: ms(nextRunAt as string | null),
    ...rest,
  });
  return id;
}

/** The in-flight occurrence this close-out must find, else it is a no-op. */
function seedRun(db: Database.Database, taskId: string, runNumber: number): string {
  const id = `run-${Math.random().toString(36).slice(2, 10)}`;
  db.prepare(`
    INSERT INTO work (id, kind, parent_id, agent_id, assignee_agent, requester, requester_id,
                      root_kind, root_id, state, intent, wakes, closes_thread, title, sequence,
                      opened_at, updated_at)
    VALUES (?, 'occurrence', ?, 'primary', 'primary', 'schedule', ?, 'schedule', ?, 'open',
            'occurrence', 0, 0, ?, ?, ?, ?)
  `).run(id, taskId, taskId, taskId, `occurrence #${runNumber}`, runNumber,
         Date.now() - 60_000, Date.now() - 60_000);
  return id;
}

beforeEach(() => {
  actionsTaken.length = 0;
  mockDb.current = new Database(':memory:');
  runMigrations();
});

describe('onTaskRunComplete finished-run log line', () => {
  it('logs the first finished run of a recurring task as #1', async () => {
    const db = mockDb.current!;
    const taskId = seedTask(db, { attempts: 0 });
    seedRun(db, taskId, 1);

    await onTaskRunComplete(taskId, 'complete', 'ok');

    expect(actionsTaken.some((a) => a?.includes('scheduler ran #1,'))).toBe(true);
  });

  it('logs the third finished run of a recurring task as #3', async () => {
    const db = mockDb.current!;
    const taskId = seedTask(db, { attempts: 2 });
    seedRun(db, taskId, 3);

    await onTaskRunComplete(taskId, 'complete', 'ok');

    expect(actionsTaken.some((a) => a?.includes('scheduler ran #3,'))).toBe(true);
  });

  it('logs a finished one-shot as final run #1', async () => {
    const db = mockDb.current!;
    const taskId = seedTask(db, {
      attempts: 0, repeat_interval: null, repeat_unit: null, next_run_at: null,
    });
    seedRun(db, taskId, 1);

    await onTaskRunComplete(taskId, 'complete', 'ok');

    expect(actionsTaken).toContain('scheduler ran final run #1, no more runs');
  });
});
