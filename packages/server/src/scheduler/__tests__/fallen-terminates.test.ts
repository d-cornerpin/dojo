// RC-17 invariants for the scheduler runner:
//   * terminateLiveScheduleOnFallen stops a live schedule so a 'fallen' task
//     can never fire again (F-17), closes any open run as 'skipped', and posts
//     an owner heads-up for a skipped reminder.
//   * onTaskRunComplete closes the run BY ID with .changes===1 and reports
//     whether it advanced, so a no-op (already-closed run) does not inflate
//     run_count (P-5) and callers can distinguish a real advance from a no-op.
//
// Follows the auto-assign-task.test.ts pattern: point getDb at an in-memory DB
// and stub the runner's heavier collaborators, then call the real functions.

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
// SWEEP CORE-2 item 3: the skipped-reminder heads-up rides this seam now, so the stub RECORDS
// rather than swallows — the assertion below reads what the owner would actually be told.
const notices: Array<{ toAgentId: string; brief: string; intent?: string; selfIntro?: boolean }> = [];
vi.mock('../../agent/agent-notice.js', () => ({
  postAgentNotice: (o: { toAgentId: string; brief: string; intent?: string; selfIntro?: boolean }) => {
    notices.push(o); return 'notice-id';
  },
}));
// T10: was `vi.mock('../../memory/interagent.js', … insertInterAgentEngineRow …)`. The shim
// is deleted; the engine row goes through the writer module, so the no-op moves there —
// and ONLY that function is replaced, because this file's other message-store consumers
// (tracker/notify.ts, tracker/tools.ts) need the real module to load at all.
vi.mock('../../memory/message-store.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../memory/message-store.js')>()),
  insertEngineEventIfAbsent: () => null,
}));
vi.mock('../../config/platform.js', () => ({
  getPrimaryAgentId: () => 'primary',
  getPMAgentId: () => 'pm',
  getOwnerName: () => 'the owner',
}));

import { terminateLiveScheduleOnFallen, onTaskRunComplete } from '../runner.js';
import { runMigrations } from '../../db/migrations.js';
import { seedTrackerTask, ms } from '../../work/__tests__/work-fixture.js';
import { occurrenceRunStatus } from '../../work/occurrence-runs.js';

function seedLiveRecurring(db: Database.Database, overrides: Record<string, unknown> = {}): string {
  const id = `task-${Math.random().toString(36).slice(2, 10)}`;
  const future = new Date(Date.now() + 60 * 60 * 1000).toISOString();
  const cols: Record<string, unknown> = {
    id,
    title: 'daily brief',
    description: 'daily brief',
    status: 'in_progress',
    created_by: 'primary',
    repeat_interval: 1,
    repeat_unit: 'days',
    schedule_status: 'running',
    next_run_at: future,
    run_count: 3,
    kind: null,
    ...overrides,
  };
  const { status, created_by: createdBy, next_run_at: nextRunAt, run_count: runCount,
    kind, assigned_to: assignedTo, project_id: projectId, ...rest } = cols as Record<string, any>;
  seedTrackerTask(db, {
    id, status: status as string, createdBy: createdBy as string,
    agentId: (assignedTo as string) ?? 'primary', projectId: (projectId as string) ?? null,
    next_run_at: ms(nextRunAt as string | null), attempts: runCount, task_kind: kind,
    ...rest,
  });
  return id;
}

/** PHASE-2 T10F: an open run is an OCCURRENCE row. `pending` and `running` were the two
 *  open `task_runs` statuses and both map to `state='open'` — the distinction was never read
 *  (every reader asked `status IN ('pending','running')` or closed on either), which is why
 *  the absorption did not need to keep it. */
function seedRun(db: Database.Database, taskId: string, _status: string, runNumber = 4): string {
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
  notices.length = 0;
  mockDb.current = new Database(':memory:');
  runMigrations();
});

describe('terminateLiveScheduleOnFallen (RC-17.5)', () => {
  it('stops a live schedule, skips the open run, and reports termination', () => {
    const db = mockDb.current!;
    const taskId = seedLiveRecurring(db, { schedule_status: 'running' });
    const runId = seedRun(db, taskId, 'running');

    const out = terminateLiveScheduleOnFallen(taskId, 'the task was marked fallen (given up on)');

    expect(out.terminated).toBe(true);
    expect(out.runsSkipped).toBe(1);

    const task = db.prepare('SELECT schedule_status, is_paused, next_run_at FROM work WHERE id = ?').get(taskId) as { schedule_status: string; is_paused: number; next_run_at: string | null };
    expect(task.schedule_status).toBe('completed');
    expect(task.is_paused).toBe(1);
    expect(task.next_run_at).toBeNull();

    // PHASE-2 T10F — RE-EXPRESSED. The open run is closed 'skipped' exactly as before; the
    // row it is closed on is the occurrence. Asserted through the projection the owner's run
    // history reads, so this clause also covers the mapping rather than just the state.
    expect(occurrenceRunStatus(runId)).toBe('skipped');

    // PHASE-2 T10G — RE-EXPRESSED, not weakened. The requirement is unchanged: terminating a
    // fallen schedule leaves an audit line somebody can find. The line is an `auto_sweep`
    // entry on the spine's own event log now, so the assertion reads the payload rather than a
    // dropped table's column — and it still pins the exact action string, which is the signal.
    const log = db.prepare(`SELECT COUNT(*) AS n FROM work_events
      WHERE work_id = ? AND kind = 'audit'
        AND json_extract(payload, '$.entry_kind') = 'auto_sweep'
        AND json_extract(payload, '$.action_taken') = 'schedule terminated on fallen'`)
      .get(taskId) as { n: number };
    expect(log.n).toBe(1);
  });

  it('is a no-op on an already-inert schedule (completed/unscheduled)', () => {
    const db = mockDb.current!;
    const taskId = seedLiveRecurring(db, { schedule_status: 'completed', next_run_at: null });

    const out = terminateLiveScheduleOnFallen(taskId);

    expect(out.terminated).toBe(false);
    expect(out.runsSkipped).toBe(0);
  });

  it('posts an owner heads-up when a skipped occurrence is a reminder', () => {
    const db = mockDb.current!;
    const taskId = seedLiveRecurring(db, { kind: 'reminder', schedule_status: 'waiting', description: 'take the trash out' });
    seedRun(db, taskId, 'pending');

    const out = terminateLiveScheduleOnFallen(taskId, 'the owner cancelled it');

    expect(out.terminated).toBe(true);
    expect(out.isReminder).toBe(true);
    // SWEEP CORE-2 item 3 (SWEEP-F T2): the heads-up left the dead channel. It was a bare
    // `role='system'` chat row written straight into the primary's chat — and the
    // model-context builder STRIPS those, so the primary's model never saw it and could never
    // relay a dropped reminder to an owner who is not sitting at the dashboard. It is an
    // awareness NOTICE now (`role='user'`, `lane='events'`, `origin_kind='engine'`), and the
    // owner-facing sentence is carried byte-for-byte — which is what the content assertions
    // still hold. The no-longer-written chat row is asserted ABSENT, so a silent revert to
    // the dead channel fails here rather than passing on the content alone.
    expect(notices.length).toBe(1);
    expect(notices[0].toAgentId).toBe('primary');
    expect(notices[0].selfIntro, 'the Scheduler is a subsystem, not an agent').toBe(false);
    expect(notices[0].intent).toBe('reminder_skipped_owner');
    expect(notices[0].brief).toContain('Heads up');
    expect(notices[0].brief).toContain('take the trash out');
    const deadChannelRow = db.prepare(
      `SELECT content FROM messages WHERE agent_id = 'primary' AND role = 'system'`,
    ).get() as { content: string } | undefined;
    expect(deadChannelRow, 'the stripped role=system chat row must not come back').toBeUndefined();
  });
});

describe('onTaskRunComplete (RC-17.2)', () => {
  it('advances exactly once and then no-ops on the already-closed run', async () => {
    const db = mockDb.current!;
    const taskId = seedLiveRecurring(db, { schedule_status: 'running' });
    seedRun(db, taskId, 'running');

    const first = await onTaskRunComplete(taskId, 'complete', 'run 4 done');
    expect(first).toBe(true);
    const afterFirst = db.prepare('SELECT attempts AS run_count FROM work WHERE id = ?').get(taskId) as { run_count: number };
    expect(afterFirst.run_count).toBe(4); // seeded 3, advanced once

    // No running run remains: a stale re-close must be a no-op, not another advance.
    const second = await onTaskRunComplete(taskId, 'complete', 'stale re-close');
    expect(second).toBe(false);
    const afterSecond = db.prepare('SELECT attempts AS run_count FROM work WHERE id = ?').get(taskId) as { run_count: number };
    expect(afterSecond.run_count).toBe(4); // unchanged, no inflation
  });
});
