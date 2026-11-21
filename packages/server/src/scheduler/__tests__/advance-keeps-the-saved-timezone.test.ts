// UX-REPAIR ROUND 2 T13, SECOND HALF — THE SCHEDULER'S OWN ADVANCE CALL SITES KEEP THE ROW'S ZONE.
//
// `engine.ts:calculateNextRun` reads the per-task zone from `task.tz` (falling back to the box
// zone), and the CREATE door persists it (`tracker/tools.ts` writes `tz: resolvedScheduleZone`),
// and `scheduleRowColumns` projects it. But the scheduler's own five call sites that build the
// `ScheduledTask` for `calculateNextRun` left `tz` out, so the row's declared zone reached
// nothing once the schedule advanced — a "9:00 in Auckland" reminder drifts by the zone
// difference after its first fire. This suite drives the REAL `forceResetStuckRecurringTask` on a
// row whose saved zone is `Pacific/Kiritimati` (UTC+14, no DST) and asserts the stored next run
// is the Kiritimati one, not the box one.

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
vi.mock('../../agent/agent-notice.js', () => ({ postAgentNotice: () => 'notice-id' }));
vi.mock('../../memory/message-store.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../memory/message-store.js')>()),
  insertEngineEventIfAbsent: () => null,
}));
vi.mock('../../config/platform.js', () => ({
  getPrimaryAgentId: () => 'primary',
  getPMAgentId: () => 'pm',
  getOwnerName: () => 'the owner',
}));

import { forceResetStuckRecurringTask } from '../runner.js';
import { calculateNextRun, type ScheduledTask } from '../engine.js';
import { scheduleRowColumns, tsToMs } from '../../work/tracker-view.js';
import { createWorkTable, seedTrackerTask, ms } from '../../work/__tests__/work-fixture.js';

const KIRI = 'Pacific/Kiritimati';   // UTC+14, no DST — can never equal the box zone in a usable way

function applySchema(db: Database.Database): void {
  createWorkTable(db);
  db.exec(`
    CREATE TABLE IF NOT EXISTS deliveries (
      id TEXT PRIMARY KEY, agent_id TEXT, outcome TEXT, tool TEXT, created_at INTEGER,
      turn_number INTEGER
    );
    CREATE TABLE IF NOT EXISTS messages (
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

/** A recurring monthly row, structurally stuck (in_progress, schedule present), with the row's
 *  own zone saved. The anchor is 2026-06-15T09:00 in `tz` — i.e. the UTC instant 2026-06-14T19:00:00Z
 *  for Kiritimati — well in the past, so `calculateNextRun` must WALK forward to the next future
 *  occurrence. The walk is where the zone difference shows: the box zone (America/Los_Angeles)
 *  crosses its DST transition between the June anchor and the November result, so the Kiritimati
 *  walk and the box walk land one hour apart — the saved zone is what decides it. */
function seedStuckRecurring(db: Database.Database, tz: string | null): string {
  const id = `task-${Math.random().toString(36).slice(2, 10)}`;
  const anchorLocal = '2026-06-15T09:00:00';            // wall time in `tz`, no offset — like the create door stores it
  const anchorIso = '2026-06-14T19:00:00.000Z';         // the UTC instant of that wall time in Kiritimati (UTC+14)
  seedTrackerTask(db, {
    id,
    title: 'monthly brief',
    description: 'monthly brief',
    status: 'in_progress',
    createdBy: 'primary',
    repeat_interval: 1,
    repeat_unit: 'months',
    repeat_end_type: 'never',
    repeat_end_value: null,
    repeat_days_of_week: null,
    schedule_status: 'waiting',
    is_paused: 0,
    scheduled_start: ms(anchorIso),
    anchor_local: anchorLocal,
    last_run_at: ms(anchorIso),
    next_run_at: ms(anchorIso),
    attempts: 1,
    tz,
  });
  return id;
}

/** The fields the scheduler reads from the row, exactly as `forceResetStuckRecurringTask` feeds
 *  them to `calculateNextRun` (via the `scheduleRowColumns` projection). */
function rowTask(db: Database.Database, id: string): ScheduledTask {
  const row = db.prepare(`SELECT ${scheduleRowColumns('w')} FROM work w WHERE w.id = ?`).get(id) as Record<string, unknown>;
  return {
    id: row.id as string,
    scheduled_start: row.scheduled_start as string | null,
    repeat_interval: row.repeat_interval as number | null,
    repeat_unit: row.repeat_unit as string | null,
    repeat_end_type: row.repeat_end_type as string | null,
    repeat_end_value: row.repeat_end_value as string | null,
    run_count: (row.run_count as number) ?? 0,
    is_paused: (row.is_paused as number) ?? 0,
    last_run_at: row.last_run_at as string | null,
    next_run_at: row.next_run_at as string | null,
    schedule_status: row.schedule_status as string,
    repeat_days_of_week: row.repeat_days_of_week as string | null,
    anchor_time: row.anchor_time as string | null,
  };
}

beforeEach(() => {
  mockDb.current = new Database(':memory:');
  applySchema(mockDb.current);
});

describe('advance keeps the row\'s saved timezone', () => {
  it('forceResetStuckRecurringTask recomputes a tz-carrying row in THAT zone, not the box zone', () => {
    const db = mockDb.current!;
    const id = seedStuckRecurring(db, KIRI);

    const base = rowTask(db, id);
    const expectedKiri = calculateNextRun({ ...base, tz: KIRI });
    const expectedBox = calculateNextRun({ ...base, tz: null });

    // Precondition: the two zones must genuinely differ here, or this test asserts nothing.
    expect(expectedKiri, 'Kiritimati and the box zone must resolve to different instants').not.toBeNull();
    expect(expectedBox, 'the box-zone computation must resolve too').not.toBeNull();
    expect(tsToMs(expectedKiri), 'Kiritimati and the box zone must differ — the saved zone is the whole point')
      .not.toBe(tsToMs(expectedBox));

    forceResetStuckRecurringTask(id);

    const stored = db.prepare('SELECT next_run_at FROM work WHERE id = ?').get(id) as { next_run_at: number | null };
    expect(stored.next_run_at).toBe(tsToMs(expectedKiri));
  });

  it('CONTROL: a row with no saved zone still resolves in the box zone (unchanged behaviour)', () => {
    const db = mockDb.current!;
    const id = seedStuckRecurring(db, null);

    const base = rowTask(db, id);
    const expectedBox = calculateNextRun({ ...base, tz: null });
    expect(expectedBox, 'the box-zone computation must resolve').not.toBeNull();

    forceResetStuckRecurringTask(id);

    const stored = db.prepare('SELECT next_run_at FROM work WHERE id = ?').get(id) as { next_run_at: number | null };
    expect(stored.next_run_at).toBe(tsToMs(expectedBox));
  });
});
