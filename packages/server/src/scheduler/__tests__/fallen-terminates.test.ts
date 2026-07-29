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
vi.mock('../../agent/agent-bus.js', () => ({ sendAgentMessage: () => { /* no-op */ } }));
vi.mock('../../agent/agent-notice.js', () => ({ postAgentNotice: () => { /* no-op */ } }));
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
import { createWorkTable, seedTrackerTask, ms } from '../../work/__tests__/work-fixture.js';
import { occurrenceRunStatus } from '../../work/occurrence-runs.js';

function applySchema(db: Database.Database): void {
  createWorkTable(db);
  db.exec(`
    -- PHASE-2 T10F: the close-out resolves the run's delivery (G7 -- a run that reached
    -- nobody cannot be 'done'), so this suite now reaches deliveryForAgentSince. It could
    -- not before: inFlightOccurrence found nothing in a task_runs-only fixture, so the whole
    -- settle branch was dark here. More of the real path runs now, which is the point.
    CREATE TABLE IF NOT EXISTS deliveries (
      id TEXT PRIMARY KEY, agent_id TEXT, outcome TEXT, tool TEXT, created_at INTEGER
    );
    -- PHASE-2 T10F: the task_runs fixture DDL is GONE with the table. A run is an
    -- occurrence work row now, and createWorkTable above already declares it, including
    -- ux_work_occurrence, so this suite's runs are subject to the same exactly-once
    -- constraint production is.
    CREATE TABLE task_log (
      id TEXT PRIMARY KEY,
      task_id TEXT NOT NULL,
      from_entity TEXT NOT NULL,
      entry_kind TEXT NOT NULL,
      from_status TEXT,
      to_status TEXT,
      reason TEXT,
      action_taken TEXT,
      note TEXT,
      evidence_json TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    -- PHASE-1 T4 (2026-07-27): widened to the migration-127 spine.
    --
    -- This fixture hand-rolled a 5-column messages table and never wrote to it, which is
    -- exactly why a write-only grep missed it and T0 flagged it in advance ("T3/T4 must
    -- use the CREATE-or-WRITE union, not the write list, or two suites break"). The
    -- scheduler's owner heads-up now goes through the single writer, whose INSERT names
    -- the whole spine, so a narrow fixture throws "no column named conversation_id"
    -- inside the writer's own non-fatal try/catch -- the row silently never lands and the
    -- test reads undefined. Widening the fixture is the honest fix: the alternative was
    -- to leave one production site unconverted so a test fixture could stay small.
    CREATE TABLE messages (
      -- PHASE-2 T3: this fixture declared seq as a plain INTEGER with id as the primary
      -- key, which has not matched the real table since migration 133 promoted seq to the
      -- INTEGER PRIMARY KEY. seq was therefore NULL on every inserted row here, so the
      -- writer's own read-back by seq found nothing and threw AFTER the row was already
      -- committed - invisible, because the caller's try/catch swallowed it. Making the
      -- insert atomic turned that swallowed throw into a rolled-back row, which surfaced it.
      seq INTEGER PRIMARY KEY,
      id TEXT NOT NULL UNIQUE,
      agent_id TEXT NOT NULL,
      conversation_id TEXT,
      lane TEXT NOT NULL DEFAULT 'owner' CHECK (lane IN ('owner','a2a','events')),
      origin_intent TEXT,
      role TEXT NOT NULL,
      content TEXT NOT NULL,
      mood TEXT,
      display_kind TEXT NOT NULL DEFAULT 'unclassified',
      display_tier TEXT NOT NULL DEFAULT 'agent-only',
      turn_number INTEGER, group_id TEXT,
      channel TEXT, sender_id TEXT,
      authorized INTEGER NOT NULL DEFAULT 0,
      source_agent_id TEXT, a2a_thread_id TEXT, a2a_intent TEXT,
      a2a_requires_response INTEGER,
      token_count INTEGER NOT NULL DEFAULT 0,
      model_id TEXT, cost REAL, latency_ms INTEGER, reasoning_content TEXT,
      inbound_meta TEXT, attachments TEXT,
      external_message_id TEXT, speaker TEXT, voice_session_id TEXT,
      task_id TEXT, run_id TEXT, root_kind TEXT, root_id TEXT,
      served_by_turn INTEGER, answer_message_id TEXT,
      swept_at TEXT, delivery_attempts INTEGER NOT NULL DEFAULT 0, next_attempt_at TEXT,
      retired_at TEXT,
      origin_kind TEXT DEFAULT NULL, source TEXT DEFAULT NULL, conv_key TEXT DEFAULT NULL,
      provenance TEXT NOT NULL DEFAULT 'live',
      sent_at INTEGER NOT NULL DEFAULT (CAST(strftime('%s','now') AS INTEGER) * 1000),
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);
}

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
  mockDb.current = new Database(':memory:');
  applySchema(mockDb.current);
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

    const log = db.prepare(`SELECT COUNT(*) AS n FROM task_log WHERE task_id = ? AND action_taken = 'schedule terminated on fallen'`).get(taskId) as { n: number };
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
    const msg = db.prepare(`SELECT content FROM messages WHERE agent_id = 'primary' AND role = 'system'`).get() as { content: string } | undefined;
    expect(msg?.content).toContain('Heads up');
    expect(msg?.content).toContain('take the trash out');
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
