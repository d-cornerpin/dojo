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

function applySchema(db: Database.Database): void {
  db.exec(`
    CREATE TABLE legacy_tasks (
      id TEXT PRIMARY KEY,
      project_id TEXT,
      title TEXT NOT NULL,
      description TEXT,
      status TEXT DEFAULT 'on_deck',
      assigned_to TEXT,
      created_by TEXT NOT NULL DEFAULT 'primary',
      priority TEXT DEFAULT 'normal',
      notes TEXT,
      original_description TEXT,
      completion_summary TEXT,
      step_number INTEGER,
      total_steps INTEGER,
      phase INTEGER DEFAULT 1,
      depends_on TEXT DEFAULT '[]',
      scheduled_start TEXT,
      repeat_interval INTEGER,
      repeat_unit TEXT,
      repeat_end_type TEXT,
      repeat_end_value TEXT,
      repeat_days_of_week TEXT,
      anchor_time TEXT,
      next_run_at TEXT,
      run_count INTEGER DEFAULT 0,
      is_paused INTEGER DEFAULT 0,
      paused_until TEXT,
      status_before_pause TEXT,
      schedule_status TEXT DEFAULT 'unscheduled',
      pause_validated INTEGER NOT NULL DEFAULT 0,
      complete_validated INTEGER NOT NULL DEFAULT 0,
      blocked_validated INTEGER NOT NULL DEFAULT 0,
      revert_count INTEGER NOT NULL DEFAULT 0,
      last_smell_flag TEXT,
      awaiting_user_verdict INTEGER NOT NULL DEFAULT 0,
      user_verdict_requested_at TEXT,
      goal TEXT,
      result TEXT,
      evidence_json TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      completed_at TEXT,
      last_run_at TEXT,
      a2a_thread_id TEXT,
      kind TEXT
    );
    CREATE TABLE task_runs (
      id TEXT PRIMARY KEY,
      task_id TEXT NOT NULL,
      run_number INTEGER NOT NULL,
      scheduled_for TEXT,
      status TEXT NOT NULL DEFAULT 'pending',
      assigned_to TEXT,
      started_at TEXT,
      completed_at TEXT,
      result_summary TEXT,
      error TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
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
    CREATE TABLE legacy_projects (
      id TEXT PRIMARY KEY, title TEXT NOT NULL, description TEXT,
      level INTEGER NOT NULL DEFAULT 1, status TEXT NOT NULL DEFAULT 'active',
      created_by TEXT NOT NULL, phase_count INTEGER NOT NULL DEFAULT 1,
      current_phase INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')), completed_at TEXT
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
  const keys = Object.keys(cols);
  db.prepare(`INSERT INTO legacy_tasks (${keys.join(',')}) VALUES (${keys.map(() => '?').join(',')})`).run(...Object.values(cols));
  return id;
}

function seedRun(db: Database.Database, taskId: string, status: string, runNumber = 4): string {
  const id = `run-${Math.random().toString(36).slice(2, 10)}`;
  db.prepare(`
    INSERT INTO task_runs (id, task_id, run_number, status, started_at, created_at)
    VALUES (?, ?, ?, ?, datetime('now'), datetime('now'))
  `).run(id, taskId, runNumber, status);
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

    const task = db.prepare('SELECT schedule_status, is_paused, next_run_at FROM legacy_tasks WHERE id = ?').get(taskId) as { schedule_status: string; is_paused: number; next_run_at: string | null };
    expect(task.schedule_status).toBe('completed');
    expect(task.is_paused).toBe(1);
    expect(task.next_run_at).toBeNull();

    const run = db.prepare('SELECT status FROM task_runs WHERE id = ?').get(runId) as { status: string };
    expect(run.status).toBe('skipped');

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
    const afterFirst = db.prepare('SELECT run_count FROM legacy_tasks WHERE id = ?').get(taskId) as { run_count: number };
    expect(afterFirst.run_count).toBe(4); // seeded 3, advanced once

    // No running run remains: a stale re-close must be a no-op, not another advance.
    const second = await onTaskRunComplete(taskId, 'complete', 'stale re-close');
    expect(second).toBe(false);
    const afterSecond = db.prepare('SELECT run_count FROM legacy_tasks WHERE id = ?').get(taskId) as { run_count: number };
    expect(afterSecond.run_count).toBe(4); // unchanged, no inflation
  });
});
