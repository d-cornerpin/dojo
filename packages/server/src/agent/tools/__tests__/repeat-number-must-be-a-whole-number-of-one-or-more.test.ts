// ════════════════════════════════════════════════════════════════════════════
// A REPEAT NUMBER THAT CANNOT STEP THE CALENDAR IS REFUSED AT EVERY AGENT DOOR
//
// The dashboard refuses `repeat_interval` 0 / -1 / 0.5 before any write
// (the same `scheduleError` check). The three doors that
// save a repeat interval for AGENTS checked only that the number is PRESENT
// (`cat/tracker.ts` `hasInterval` / `remHasInterval`, `tracker/tools.ts`
// `effHasInterval`), never that it is a usable one. A zero, negative or
// fractional number reached the engine, whose `calculateNextRun` returns null
// for it, the scheduler completed the schedule, the task or reminder fired once
// and never again — and the agent had been told "recurring" with no error.
//
// Each door now refuses the number itself, before its pairing checks, in the
// error shape it already uses, and writes nothing.
// ════════════════════════════════════════════════════════════════════════════
import { describe, it, expect, beforeEach, vi } from 'vitest';
import Database from 'better-sqlite3';

const mockDb = { current: null as Database.Database | null };

vi.mock('../../../db/connection.js', () => ({
  getDb: () => {
    if (!mockDb.current) throw new Error('test DB not initialized');
    return mockDb.current;
  },
}));
vi.mock('../../../gateway/ws.js', () => ({ broadcast: () => { /* no-op */ } }));
vi.mock('../../runtime.js', () => ({
  getAgentRuntime: () => ({ handleMessage: async () => { /* no-op */ } }),
}));
vi.mock('../../agent-notice.js', () => ({ postAgentNotice: () => { /* no-op */ } }));
vi.mock('../../../memory/message-store.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../memory/message-store.js')>()),
  insertEngineEventIfAbsent: () => null,
}));
vi.mock('../../../tracker/pm-agent.js', () => ({
  ensurePMAgentRunning: () => { /* no-op */ },
}));
vi.mock('../../../tracker/notify.js', () => ({
  injectTaskAssignmentNotification: () => { /* no-op */ },
}));
vi.mock('../../../config/platform.js', () => ({
  isSystemServiceAgent: () => false,
  getPrimaryAgentId: () => 'primary',
  isPrimaryAgent: (id: string) => id === 'primary',
  getPMAgentId: () => 'pm',
  getOwnerName: () => 'the owner',
  isPMAgent: (id: string) => id === 'pm',
}));

import { trackerHandlers } from '../../../agent/tools/cat/tracker.js';
import { trackerEditTask } from '../../../tracker/tools.js';
import { createWorkTable, seedTrackerTask } from '../../../work/__tests__/work-fixture.js';

const AGENT = 'a1';
const START = '2026-12-01T09:00:00Z';

function applySchema(db: Database.Database): void {
  createWorkTable(db);
  db.exec(`
    CREATE TABLE IF NOT EXISTS agents (
      id TEXT PRIMARY KEY, name TEXT, status TEXT, agent_type TEXT, model_id TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    INSERT INTO agents (id, name, status) VALUES ('a1', 'Agent One', 'idle');
    CREATE TABLE IF NOT EXISTS deliveries (
      id TEXT PRIMARY KEY, agent_id TEXT, outcome TEXT, tool TEXT, created_at INTEGER
    );
    CREATE TABLE IF NOT EXISTS messages (
      seq INTEGER PRIMARY KEY, id TEXT NOT NULL UNIQUE, agent_id TEXT NOT NULL,
      conversation_id TEXT,
      lane TEXT NOT NULL DEFAULT 'owner' CHECK (lane IN ('owner','a2a','events')),
      origin_intent TEXT, role TEXT NOT NULL, content TEXT NOT NULL, mood TEXT,
      display_kind TEXT NOT NULL DEFAULT 'unclassified',
      display_tier TEXT NOT NULL DEFAULT 'agent-only',
      turn_number INTEGER, group_id TEXT, channel TEXT, sender_id TEXT,
      authorized INTEGER NOT NULL DEFAULT 0,
      source_agent_id TEXT, a2a_thread_id TEXT, a2a_intent TEXT,
      a2a_requires_response INTEGER, token_count INTEGER NOT NULL DEFAULT 0,
      model_id TEXT, cost REAL, latency_ms INTEGER, reasoning_content TEXT,
      inbound_meta TEXT, attachments TEXT, external_message_id TEXT, speaker TEXT,
      voice_session_id TEXT, task_id TEXT, run_id TEXT, root_kind TEXT, root_id TEXT,
      served_by_turn INTEGER, answer_message_id TEXT, swept_at TEXT,
      delivery_attempts INTEGER NOT NULL DEFAULT 0, next_attempt_at TEXT, retired_at TEXT,
      origin_kind TEXT DEFAULT NULL, source TEXT DEFAULT NULL, conv_key TEXT DEFAULT NULL,
      provenance TEXT NOT NULL DEFAULT 'live',
      sent_at INTEGER NOT NULL DEFAULT (CAST(strftime('%s','now') AS INTEGER) * 1000),
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);
}

beforeEach(() => {
  const db = new Database(':memory:');
  applySchema(db);
  mockDb.current = db;
});

/** The refusal every door returns for an unusable repeat number (the model hint follows it). */
function refusedRepeat(value: unknown): string {
  return `Error: The repeat interval "${value}" must be a whole number of 1 or more; `
    + 'zero, negative or fractional numbers cannot repeat. Nothing was saved.';
}

const BAD_VALUES: readonly unknown[] = [0, -1, 0.5, NaN];

function workRowCount(): number {
  return (mockDb.current!.prepare('SELECT COUNT(*) AS n FROM work').get() as { n: number }).n;
}

function latestWorkRow(): { task_kind: string | null; repeat_interval: number | null; repeat_unit: string | null } {
  return mockDb.current!.prepare(
    'SELECT task_kind, repeat_interval, repeat_unit FROM work ORDER BY rowid DESC LIMIT 1',
  ).get() as { task_kind: string | null; repeat_interval: number | null; repeat_unit: string | null };
}

// ── 1 · work_open(kind="task") ───────────────────────────────────────────────
describe('work_open(kind="task") refuses a repeat number that cannot repeat', () => {
  for (const value of BAD_VALUES) {
    it(`repeat_interval=${value} is refused and writes no row`, async () => {
      const res = await trackerHandlers['work_open:task']({
        agentId: AGENT,
        args: {
          title: 'daily brief', goal: 'brief the owner daily',
          scheduled_start: START, repeat_interval: value, repeat_unit: 'days',
        },
      } as never);
      expect(res.isError, `a task with repeat_interval=${String(value)} opened:\n${res.content}`).toBe(true);
      expect(res.content).toContain(refusedRepeat(value));
      expect(workRowCount(), 'the refused call wrote a row anyway').toBe(0);
    });
  }

  for (const value of [1, 3]) {
    it(`repeat_interval=${value} still opens a recurring task`, async () => {
      const res = await trackerHandlers['work_open:task']({
        agentId: AGENT,
        args: {
          title: 'daily brief', goal: 'brief the owner daily',
          scheduled_start: START, repeat_interval: value, repeat_unit: 'days',
        },
      } as never);
      expect(res.isError, res.content).toBe(false);
      expect(latestWorkRow().repeat_interval).toBe(value);
    });
  }
});

// ── 2 · work_open(kind="reminder") ───────────────────────────────────────────
describe('work_open(kind="reminder") refuses a repeat number that cannot repeat', () => {
  for (const value of BAD_VALUES) {
    it(`repeat_interval=${value} is refused and writes no row`, async () => {
      const res = await trackerHandlers['work_open:reminder']({
        agentId: AGENT,
        args: {
          what: 'stand up and stretch', when: START,
          repeat_interval: value, repeat_unit: 'days',
        },
      } as never);
      expect(res.isError, `a reminder with repeat_interval=${String(value)} opened:\n${res.content}`).toBe(true);
      expect(res.content).toContain(refusedRepeat(value));
      expect(workRowCount(), 'the refused call wrote a row anyway').toBe(0);
    });
  }

  for (const value of [1, 3]) {
    it(`repeat_interval=${value} still opens a recurring reminder`, async () => {
      const res = await trackerHandlers['work_open:reminder']({
        agentId: AGENT,
        args: {
          what: 'stand up and stretch', when: START,
          repeat_interval: value, repeat_unit: 'days',
        },
      } as never);
      expect(res.isError, res.content).toBe(false);
      const row = latestWorkRow();
      expect(row.task_kind).toBe('reminder');
      expect(row.repeat_interval).toBe(value);
    });
  }
});

// ── 3 · work_update(action="edit") / trackerEditTask ─────────────────────────
// The edit door is `trackerEditTask`, which returns a plain string. A daily
// task that has already run once — the shape the report showed.
function seedRunningTask(db: Database.Database): void {
  seedTrackerTask(db, {
    id: 'task-repeat-edit', agentId: AGENT, title: 'daily brief', status: 'on_deck',
    scheduled_start: Date.parse('2026-08-01T09:00:00Z'),
    repeat_interval: 1, repeat_unit: 'days', repeat_end_type: 'never',
    anchor_local: '2026-08-01T09:00:00.000Z', schedule_status: 'waiting',
    attempts: 1, last_run_at: Date.parse('2026-10-30T09:00:00Z'),
    next_run_at: Date.parse('2026-10-31T09:00:00Z'),
  });
}

interface ScheduleRow {
  scheduled_start: number | null; repeat_interval: number | null; repeat_unit: string | null;
  next_run_at: number | null; schedule_status: string | null;
}

function scheduleRow(): ScheduleRow {
  return mockDb.current!.prepare(
    `SELECT scheduled_start, repeat_interval, repeat_unit, next_run_at, schedule_status
       FROM work WHERE id = 'task-repeat-edit'`,
  ).get() as ScheduleRow;
}

describe('trackerEditTask refuses a repeat number that cannot repeat', () => {
  for (const value of BAD_VALUES) {
    it(`repeat_interval=${value} is refused and changes no row`, () => {
      seedRunningTask(mockDb.current!);
      const before = scheduleRow();
      const res = trackerEditTask(AGENT, { taskId: 'task-repeat-edit', repeat_interval: value });
      expect(res, `an edit to repeat_interval=${String(value)} was accepted:\n${res}`).toContain(refusedRepeat(value));
      expect(scheduleRow(), 'the refused edit touched the row').toEqual(before);
    });
  }

  for (const value of [1, 3]) {
    it(`repeat_interval=${value} still edits through`, () => {
      seedRunningTask(mockDb.current!);
      const res = trackerEditTask(AGENT, { taskId: 'task-repeat-edit', repeat_interval: value });
      expect(res.startsWith('Error:'), res).toBe(false);
      expect(scheduleRow().repeat_interval).toBe(value);
    });
  }

  it('repeat_interval=null still clears the repeat', () => {
    seedRunningTask(mockDb.current!);
    const res = trackerEditTask(AGENT, { taskId: 'task-repeat-edit', repeat_interval: null, repeat_unit: null });
    expect(res.startsWith('Error:'), res).toBe(false);
    const row = scheduleRow();
    expect(row.repeat_interval).toBeNull();
    expect(row.repeat_unit).toBeNull();
  });
});
