// ════════════════════════════════════════════════════════════════════════════
// THE RESUME SEAM: paused -> next-run-out, THROUGH THE RESUME DOOR.
// `trackerResumeSchedule` reads the row with `scheduleRowColumns('w')` (which
// includes `repeat_days_of_week` and `tz`) but builds the `scheduledTask` handed
// to `calculateNextRun` from a hand-picked subset that dropped both. So a paused
// Mon+Wed schedule that has already run came back with `next_run_at = NULL` and
// the reply "Next run: none" — it never fires again — and a task's declared
// timezone resolved in the box zone instead. Every clause here goes through
// `trackerHandlers['work_schedule:resume']`, the object the tool executor
// dispatches into.
// ════════════════════════════════════════════════════════════════════════════
import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest';
import Database from 'better-sqlite3';

const mockDb = { current: null as Database.Database | null };

vi.mock('../../db/connection.js', () => ({
  getDb: () => {
    if (!mockDb.current) throw new Error('test DB not initialized');
    return mockDb.current;
  },
}));
vi.mock('../../gateway/ws.js', () => ({ broadcast: () => { /* no-op */ } }));
vi.mock('../../agent/runtime.js', () => ({
  getAgentRuntime: () => ({ handleMessage: async () => { /* no-op */ } }),
}));
vi.mock('../../agent/agent-notice.js', () => ({ postAgentNotice: () => { /* no-op */ } }));
vi.mock('../../memory/message-store.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../memory/message-store.js')>()),
  insertEngineEventIfAbsent: () => null,
}));
vi.mock('../pm-agent.js', () => ({
  ensurePMAgentRunning: () => { /* no-op */ },
}));
vi.mock('../notify.js', () => ({
  injectTaskAssignmentNotification: () => { /* no-op */ },
}));
vi.mock('../../config/platform.js', () => ({
  getPrimaryAgentId: () => 'primary',
  isPrimaryAgent: (id: string) => id === 'primary',
  getPMAgentId: () => 'pm',
  getOwnerName: () => 'the owner',
  isPMAgent: (id: string) => id === 'pm',
}));

import { trackerHandlers } from '../../agent/tools/cat/tracker.js';
import { createWorkTable, seedTrackerTask } from '../../work/__tests__/work-fixture.js';
import { instantToWall } from '../../scheduler/engine.js';

const AGENT = 'a1';
const ORIGINAL_TZ = process.env.TZ;
// The single pinned zone for the weekday clauses; the box zone the engine reads.
const PINNED = 'America/Los_Angeles';
// Case 4's two box zones, opposite sides of UTC, as the anchor-time seam uses.
const ZONES = ['America/Los_Angeles', 'Asia/Tokyo'] as const;

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
  `);
}

/** The resume door's row, as the engine would see it. `next_run_at` is the raw ms. */
const rowOf = (id: string): Record<string, unknown> =>
  mockDb.current!.prepare(
    'SELECT scheduled_start, repeat_unit, repeat_days_of_week, tz, is_paused, attempts, next_run_at, schedule_status FROM work WHERE id = ?',
  ).get(id) as Record<string, unknown>;

/** Day-of-week (0=Sun..6=Sat) of the calendar date a UTC instant reads in `zone`. */
const wallWeekday = (instantMs: number, zone: string): number => {
  const w = instantToWall(instantMs, zone);
  return new Date(Date.UTC(w.year, w.month - 1, w.day)).getUTCDay();
};

const resume = async (id: string): Promise<{ content: string; isError: boolean }> =>
  trackerHandlers['work_schedule:resume']({ agentId: AGENT, args: { task_id: id } } as never);

beforeEach(() => {
  const db = new Database(':memory:');
  applySchema(db);
  mockDb.current = db;
});

afterAll(() => {
  if (ORIGINAL_TZ === undefined) delete process.env.TZ;
  else process.env.TZ = ORIGINAL_TZ;
});

// ── 1 · SPECIFIC-DAYS, ALREADY RUN: the resumed task must still fire ──────────
describe('work_schedule(action="resume") keeps specific_days for a task that has run', () => {
  it('a paused Mon+Wed schedule that has run before resumes to a future run on an allowed weekday', async () => {
    process.env.TZ = PINNED;
    // A Monday two weeks in the past (Oct 12 is Mon, 06:00 PDT), already fired twice.
    seedTrackerTask(mockDb.current!, {
      id: 'task-mw', agentId: AGENT, title: 'mon-wed brief', status: 'on_deck',
      scheduled_start: Date.parse('2026-10-12T13:00:00.000Z'),
      repeat_interval: 1, repeat_unit: 'specific_days', repeat_end_type: 'never',
      repeat_days_of_week: '1,3',
      anchor_local: '2026-10-12T13:00:00.000Z',
      attempts: 2, last_run_at: Date.parse('2026-10-27T13:00:00.000Z'),
      is_paused: 1, schedule_status: 'paused', tz: null,
    });
    const res = await resume('task-mw');
    expect(res.isError, res.content).toBe(false);
    // The reply must name a real next run, not "Next run: none".
    expect(res.content, 'the resume door dropped the weekday list: the reply says "Next run: none"').not.toContain('Next run: none');
    const nextRun = Number(rowOf('task-mw').next_run_at);
    expect(nextRun, 'the resume door dropped the weekday list: next_run_at is null').not.toBeNaN();
    expect(nextRun).toBeGreaterThan(Date.now());
    expect(
      wallWeekday(nextRun, PINNED),
      `next_run_at (${new Date(nextRun).toISOString()}) does not land on Mon or Wed in ${PINNED}`,
    ).toBeGreaterThanOrEqual(1);
    expect(wallWeekday(nextRun, PINNED)).toBeLessThanOrEqual(3);
    expect([1, 3]).toContain(wallWeekday(nextRun, PINNED));
  });
});

// ── 2 · SPECIFIC-DAYS, NEVER RUN: the first run lands on an allowed weekday ───
describe('work_schedule(action="resume") keeps specific_days for a task that never ran', () => {
  it('a paused never-run specific_days task resumes to a first run on an allowed weekday', async () => {
    process.env.TZ = PINNED;
    // A Tuesday start (Oct 6 is Tue, 06:00 PDT): never fired, so the first run
    // must land on the next allowed day, not fire on the disallowed Tuesday.
    seedTrackerTask(mockDb.current!, {
      id: 'task-never', agentId: AGENT, title: 'never-fired', status: 'on_deck',
      scheduled_start: Date.parse('2026-10-06T13:00:00.000Z'),
      repeat_interval: 1, repeat_unit: 'specific_days', repeat_end_type: 'never',
      repeat_days_of_week: '1,3',
      anchor_local: '2026-10-06T13:00:00.000Z',
      attempts: 0, last_run_at: null,
      is_paused: 1, schedule_status: 'paused', tz: null,
    });
    const res = await resume('task-never');
    expect(res.isError, res.content).toBe(false);
    const nextRun = Number(rowOf('task-never').next_run_at);
    expect(nextRun, 'the resume door dropped the weekday list: no next_run_at').not.toBeNaN();
    expect(
      wallWeekday(nextRun, PINNED),
      `the never-run first fire (${new Date(nextRun).toISOString()}) landed on a disallowed weekday in ${PINNED}`,
    ).toBeGreaterThanOrEqual(1);
    expect([1, 3]).toContain(wallWeekday(nextRun, PINNED));
  });
});

// ── 3 · CONTROL: a plain daily schedule resumes exactly as before ─────────────
describe('work_schedule(action="resume") — days control', () => {
  it('a paused daily schedule that has run resumes to a future next run', async () => {
    process.env.TZ = PINNED;
    seedTrackerTask(mockDb.current!, {
      id: 'task-days', agentId: AGENT, title: 'daily brief', status: 'on_deck',
      scheduled_start: Date.parse('2026-10-14T09:15:00.000Z'),
      repeat_interval: 1, repeat_unit: 'days', repeat_end_type: 'never',
      anchor_local: '2026-10-14T09:15:00.000Z',
      attempts: 3, last_run_at: Date.parse('2026-10-27T09:15:00.000Z'),
      is_paused: 1, schedule_status: 'paused', tz: null,
    });
    const res = await resume('task-days');
    expect(res.isError, res.content).toBe(false);
    expect(res.content, 'the days control must name a next run').toContain('Next run:');
    expect(res.content).not.toContain('Next run: none');
    const nextRun = Number(rowOf('task-days').next_run_at);
    expect(nextRun, 'the days control must carry a next_run_at').not.toBeNaN();
    expect(nextRun).toBeGreaterThan(Date.now());
  });
});

// ── 4 · THE DECLARED ZONE SURVIVES: weeks run on the task's own zone ──────────
describe('work_schedule(action="resume") keeps the declared timezone', () => {
  for (const zone of ZONES) {
    it(`in a ${zone} box, a paused weeks task with tz=America/Los_Angeles resumes at the anchor's 06:00 LA wall time`, async () => {
      process.env.TZ = zone;
      // A Monday anchor at 06:00 PDT (Oct 5), already fired twice; the walk from
      // it crosses the Nov 1 DST fall-back, so the resolved zone decides the hour.
      seedTrackerTask(mockDb.current!, {
        id: `task-wk-${zone}`, agentId: AGENT, title: 'weekly brief', status: 'on_deck',
        scheduled_start: Date.parse('2026-10-05T13:00:00.000Z'),
        repeat_interval: 1, repeat_unit: 'weeks', repeat_end_type: 'never',
        anchor_local: '2026-10-05T13:00:00.000Z',
        tz: 'America/Los_Angeles',
        attempts: 3, last_run_at: Date.parse('2026-10-21T13:00:00.000Z'),
        is_paused: 1, schedule_status: 'on_deck',
      });
      const res = await resume(`task-wk-${zone}`);
      expect(res.isError, res.content).toBe(false);
      const nextRun = Number(rowOf(`task-wk-${zone}`).next_run_at);
      expect(nextRun, `the resume door dropped tz: no next_run_at in a ${zone} box`).not.toBeNaN();
      const laWall = instantToWall(nextRun, 'America/Los_Angeles');
      expect(
        { hour: laWall.hour, minute: laWall.minute },
        `next_run_at (${new Date(nextRun).toISOString()}) lost the 06:00 LA wall of the anchor in a ${zone} box — tz was dropped, so the walk used the box zone`,
      ).toEqual({ hour: 6, minute: 0 });
    });
  }
});
