// ════════════════════════════════════════════════════════════════════════════
// THE RECURRING-SCHEDULE SEAM: anchor-in -> next-run-out, THROUGH THE DOOR.
// PHASE-6 T0A Step 1. RED-first: every clause below failed at `d716172`.
//
// ── WHY THE DOOR AND NOT THE INNER FUNCTION ─────────────────────────────────
// `trackerEditTask` and `trackerCreateTask` have supported `anchor_time` end to
// end since v2.5.45. The defect the owner's agent measured is one layer above
// them: the AGENT-FACING doors in `agent/tools/cat/tracker.ts` build a NEW args
// object and hand-pick which keys go through, and `anchor_time` was on neither
// pick list — the edit door's verbatim forward list nor the create door's
// forward block. So a test written against `trackerEditTask` passes on the
// pre-fix tree and proves nothing at all. Every clause here goes through
// `trackerHandlers[...]`, the object the tool executor dispatches into.
//
// ── WHAT THE CLAUSES PIN ────────────────────────────────────────────────────
//   1. an ISO-UTC `anchor_time` on EDIT stores the INSTANT IT NAMES;
//   2. the same on CREATE;
//   3. next_run_at is computed FROM that anchor, in two box timezones, landing
//      on the anchor's own wall-clock time-of-day in each — which is the whole
//      point of an anchor ("every Monday at 06:00", never "whenever the last
//      run finished");
//   4. the NEGATIVE CONTROL: with the anchor dropped at the door the row keeps
//      whatever the anchor defaulted to, so the failure names `anchor_time`.
//
// The `scheduled_start` clauses are PINS, not RED arms: they were already green
// at `d716172` and they are here because the owner's box reported a +7h store
// on `scheduled_start` (issues log 2026-08-03) on an older build. They record
// that this build stores the instant it is given, so a future regression of
// that class is caught here rather than on his box.
//
// Timezone method: `calculateNextRun` reads the box zone from
// `getBoxTimeZone()` -> `Intl.DateTimeFormat().resolvedOptions().timeZone`,
// which follows `process.env.TZ` at call time (verified on this Node). The two
// zones are chosen on opposite sides of UTC so a sign error cannot pass both.
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
vi.mock('../../agent/agent-bus.js', () => ({ sendAgentMessage: () => { /* no-op */ } }));
vi.mock('../../agent/agent-notice.js', () => ({ postAgentNotice: () => { /* no-op */ } }));
vi.mock('../../memory/message-store.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../memory/message-store.js')>()),
  insertEngineEventIfAbsent: () => null,
}));
vi.mock('../pm-agent.js', () => ({
  ensurePMAgentRunning: () => { /* no-op */ },
  noteTransitionForReview: () => { /* no-op */ },
}));
vi.mock('../notify.js', () => ({
  injectTaskAssignmentNotification: () => { /* no-op */ },
  claimAssignmentNoticeForTerminalTask: () => false,
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
import { getBoxTimeZone, instantToWall } from '../../scheduler/engine.js';
import { WORK_EDITABLE_TASK_FIELDS } from '../../agent/work-verb-schema.js';

const AGENT = 'a1';
const ORIGINAL_TZ = process.env.TZ;

/** The two box zones. Opposite sides of UTC, so a sign error cannot pass both. */
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

/** A live daily recurring task whose anchor defaults to its start. */
function seedDaily(db: Database.Database, id: string, startIso: string): void {
  seedTrackerTask(db, {
    id, agentId: AGENT, title: 'daily brief', status: 'on_deck',
    scheduled_start: Date.parse(startIso),
    repeat_interval: 1, repeat_unit: 'days', repeat_end_type: 'never',
    anchor_local: startIso, schedule_status: 'waiting',
    next_run_at: Date.parse(startIso),
  });
}

const rowOf = (id: string): Record<string, unknown> =>
  mockDb.current!.prepare(
    'SELECT anchor_local, scheduled_start, next_run_at, repeat_interval, repeat_unit FROM work WHERE id = ?',
  ).get(id) as Record<string, unknown>;

beforeEach(() => {
  const db = new Database(':memory:');
  applySchema(db);
  mockDb.current = db;
});

afterAll(() => {
  if (ORIGINAL_TZ === undefined) delete process.env.TZ;
  else process.env.TZ = ORIGINAL_TZ;
});

// ── 1 · THE EDIT DOOR ───────────────────────────────────────────────────────
describe('work_update(action="edit") — the anchor reaches the row', () => {
  it('an ISO-UTC anchor_time stores the INSTANT IT NAMES (round-trip, byte-faithful)', async () => {
    // The start is deliberately NOT the anchor: if the door drops anchor_time the
    // row keeps the start-derived anchor and this clause names the dropped key.
    seedDaily(mockDb.current!, 'task-w1-anchor', '2026-08-05T09:15:00.000Z');
    const res = await trackerHandlers['work_update:edit']({
      agentId: AGENT, args: { task_id: 'task-w1-anchor', anchor_time: '2026-08-05T13:00:00Z' },
    } as never);
    expect(res.isError, `door refused the edit: ${res.content}`).toBe(false);
    expect(
      rowOf('task-w1-anchor').anchor_local,
      'the edit door dropped `anchor_time`: the row still carries the start-derived anchor',
    ).toBe('2026-08-05T13:00:00.000Z');
  });

  it('PIN (green before the fix): an ISO-UTC scheduled_start stores the instant it names — no +7h', async () => {
    seedDaily(mockDb.current!, 'task-w2-start', '2026-08-05T09:15:00.000Z');
    const res = await trackerHandlers['work_update:edit']({
      agentId: AGENT, args: { task_id: 'task-w2-start', scheduled_start: '2026-08-05T03:00:00Z' },
    } as never);
    expect(res.isError, res.content).toBe(false);
    expect(rowOf('task-w2-start').scheduled_start).toBe(Date.parse('2026-08-05T03:00:00Z'));
  });

  it('clearing the anchor reaches the row too (null is a value, not an absence)', async () => {
    seedDaily(mockDb.current!, 'task-w3-clear', '2026-08-05T09:15:00.000Z');
    const res = await trackerHandlers['work_update:edit']({
      agentId: AGENT, args: { task_id: 'task-w3-clear', anchor_time: null },
    } as never);
    expect(res.isError, res.content).toBe(false);
    expect(
      rowOf('task-w3-clear').anchor_local,
      'the edit door dropped a null `anchor_time`, so the documented clear is unreachable',
    ).toBeNull();
  });
});

// ── 1b · THE ADVERTISEMENT IS REACHABLE, FIELD BY FIELD, WITH A DENOMINATOR ──
//
// The refusal at `tracker/tools.ts` names its editable fields to the model. This
// drives EVERY ONE of them through the door ALONE and asserts the door does not
// answer with the very message that advertised it. At `d716172` `anchor_time`
// failed exactly that way — the message said "Editable: … anchor_time …" and
// answering with only `anchor_time` returned that same message. Denominator:
// `WORK_EDITABLE_TASK_FIELDS.length`, printed by the clause itself.
describe('every field the refusal advertises is reachable through the door', () => {
  const VALUE_FOR: Record<string, unknown> = {
    title: 'a new title',
    description: 'a new description',
    goal: 'the definition of done, restated',
    depends_on: [],
    step_number: 2,
    phase: 2,
    scheduled_start: '2026-08-06T09:15:00Z',
    repeat_interval: 2,
    repeat_unit: 'days',
    repeat_end_type: 'never',
    repeat_end_value: '5',
    repeat_days_of_week: ['mon'],
    anchor_time: '2026-08-05T13:00:00Z',
    priority: 'high',
    notes: 'a note',
  };

  it(`all ${WORK_EDITABLE_TASK_FIELDS.length} advertised fields are accepted when supplied alone`, async () => {
    const refused: string[] = [];
    let examined = 0;
    for (const field of WORK_EDITABLE_TASK_FIELDS) {
      examined++;
      const id = `task-adv-${field}`;
      seedDaily(mockDb.current!, id, '2026-08-05T09:15:00.000Z');
      expect(VALUE_FOR, `no probe value declared for advertised field ${field}`).toHaveProperty(field);
      const res = await trackerHandlers['work_update:edit']({
        agentId: AGENT, args: { task_id: id, [field]: VALUE_FOR[field] },
      } as never);
      if (res.isError && String(res.content).includes('at least one editable field')) {
        refused.push(`${field} -> ${String(res.content).slice(0, 90)}`);
      }
    }
    expect(examined).toBe(WORK_EDITABLE_TASK_FIELDS.length);
    expect(
      refused,
      `${refused.length} of ${examined} advertised editable field(s) are dropped at the door — ` +
      `the tool advertises them and then denies they exist:\n${refused.join('\n')}`,
    ).toEqual([]);
  });
});

// ── 2 · THE CREATE DOOR ─────────────────────────────────────────────────────
describe('work_open(kind="task") — the anchor reaches the row', () => {
  it('an explicit anchor_time survives creation and is not overwritten by scheduled_start', async () => {
    const res = await trackerHandlers['work_open:task']({
      agentId: AGENT,
      args: {
        title: 'morning brief', goal: 'brief the owner every morning',
        scheduled_start: '2026-08-05T09:15:00Z',
        repeat_interval: 1, repeat_unit: 'days',
        anchor_time: '2026-08-05T13:00:00Z',
      },
    } as never);
    expect(res.isError, `create door refused: ${res.content}`).toBe(false);
    const row = mockDb.current!.prepare(
      "SELECT anchor_local FROM work WHERE kind='task' AND title='morning brief'",
    ).get() as { anchor_local: string | null };
    expect(
      row?.anchor_local,
      'the create door dropped `anchor_time`: the anchor defaulted to scheduled_start',
    ).toBe('2026-08-05T13:00:00.000Z');
  });
});

// ── 3 · ANCHOR-IN -> NEXT-RUN-OUT, ACROSS TWO BOX TIMEZONES ─────────────────
describe('the seam: the anchor decides next_run_at, in whatever zone the box runs', () => {
  for (const zone of ZONES) {
    it(`EDIT: in ${zone} the next run lands on the anchor's own wall-clock time-of-day`, async () => {
      process.env.TZ = zone;
      expect(getBoxTimeZone()).toBe(zone);
      // Start and anchor deliberately differ by hours; a daily repeat that has
      // already run must next fire at the ANCHOR's time-of-day, not the start's.
      seedTrackerTask(mockDb.current!, {
        id: `task-z-${zone}`, agentId: AGENT, title: 'daily brief', status: 'on_deck',
        scheduled_start: Date.parse('2026-08-01T09:15:00Z'),
        repeat_interval: 1, repeat_unit: 'days', repeat_end_type: 'never',
        anchor_local: '2026-08-01T09:15:00.000Z', schedule_status: 'waiting',
        attempts: 3, last_run_at: Date.parse('2026-08-04T09:15:00Z'),
        next_run_at: Date.parse('2026-08-05T09:15:00Z'),
      });
      const anchorIso = '2026-08-05T13:00:00Z';
      const res = await trackerHandlers['work_update:edit']({
        agentId: AGENT, args: { task_id: `task-z-${zone}`, anchor_time: anchorIso },
      } as never);
      expect(res.isError, res.content).toBe(false);

      const row = rowOf(`task-z-${zone}`);
      expect(row.anchor_local, 'anchor did not reach the row').toBe('2026-08-05T13:00:00.000Z');

      const wantWall = instantToWall(Date.parse(anchorIso), zone);
      const gotWall = instantToWall(Number(row.next_run_at), zone);
      expect(
        { hour: gotWall.hour, minute: gotWall.minute },
        `next_run_at (${new Date(Number(row.next_run_at)).toISOString()}) does not fire at the anchor's ` +
        `wall-clock time-of-day in ${zone} — the door dropped anchor_time, so the schedule still rides scheduled_start`,
      ).toEqual({ hour: wantWall.hour, minute: wantWall.minute });
      // And it is genuinely in the future, which is what "next run" means.
      expect(Number(row.next_run_at)).toBeGreaterThan(Date.now());
    });

    it(`CREATE: in ${zone} the next run lands on the anchor's own wall-clock time-of-day`, async () => {
      process.env.TZ = zone;
      expect(getBoxTimeZone()).toBe(zone);
      const startIso = new Date(Date.now() + 60 * 60 * 1000).toISOString();
      // Anchor an hour and a half BEFORE the start, so an anchor-blind path
      // (which would use the start) produces a different wall time.
      const anchorIso = new Date(Date.parse(startIso) - 90 * 60 * 1000).toISOString();
      const res = await trackerHandlers['work_open:task']({
        agentId: AGENT,
        args: {
          title: `anchored-${zone}`, goal: 'fire at a fixed wall time',
          scheduled_start: startIso, repeat_interval: 1, repeat_unit: 'days',
          anchor_time: anchorIso,
        },
      } as never);
      expect(res.isError, res.content).toBe(false);
      const row = mockDb.current!.prepare(
        'SELECT anchor_local, next_run_at FROM work WHERE title = ?',
      ).get(`anchored-${zone}`) as { anchor_local: string | null; next_run_at: number | null };
      expect(row?.anchor_local, 'the create door dropped `anchor_time`').toBe(new Date(anchorIso).toISOString());
      // First run of a never-run task is the scheduled_start by design; the
      // anchor governs every run AFTER it, which is what the stored value is for.
      expect(row.next_run_at).toBe(Date.parse(startIso));
    });

    // UX-REPAIR round 2 T13 — THE DECLARED ZONE SURVIVES THE WRITE.
    // `resolveLocalWallClock` has always resolved a caller-supplied `local_timezone`
    // correctly and then DISCARDED the resolved zone: the `alongside` patch carried
    // scheduled_start / repeat_* / anchor_local and no zone, `work.tz` was absent from
    // `TrackerAttr` so nothing could name it, and it was absent from `scheduleRowColumns` so
    // the scheduler never read it. Every calendar-unit advance therefore resolved against the
    // PROCESS timezone, and the same reminder fires an hour early for four months of the year
    // on a box running TZ=UTC. This clause is the end-to-end proof that the column is written.
    it(`CREATE in ${zone}: an explicitly declared local_timezone reaches work.tz`, async () => {
      process.env.TZ = zone;
      const declared = zone === 'Asia/Tokyo' ? 'America/Los_Angeles' : 'Asia/Tokyo';
      const future = new Date(Date.now() + 36 * 60 * 60 * 1000);
      const wall = `${future.getUTCFullYear()}-${String(future.getUTCMonth() + 1).padStart(2, '0')}-`
        + `${String(future.getUTCDate()).padStart(2, '0')}T09:00`;
      const res = await trackerHandlers['work_open:task']({
        agentId: AGENT,
        args: {
          title: `zoned-${zone}`, goal: 'fire at nine, in the zone the caller named',
          local_time: wall, local_timezone: declared,
          repeat_interval: 1, repeat_unit: 'months',
        },
      } as never);
      expect(res.isError, res.content).toBe(false);
      const row = mockDb.current!.prepare(
        'SELECT tz, scheduled_start FROM work WHERE title = ?',
      ).get(`zoned-${zone}`) as { tz: string | null; scheduled_start: number | null };
      expect(row?.tz, 'the create door dropped the declared timezone').toBe(declared);
      // …and it is the DECLARED zone that resolved the instant, not the box's.
      expect(instantToWall(Number(row.scheduled_start), declared).hour).toBe(9);
    });

    it(`CREATE in ${zone}: a caller who names NO zone still gets today's behaviour (tz null)`, async () => {
      process.env.TZ = zone;
      const startIso = new Date(Date.now() + 60 * 60 * 1000).toISOString();
      const res = await trackerHandlers['work_open:task']({
        agentId: AGENT,
        args: {
          title: `unzoned-${zone}`, goal: 'no zone named',
          scheduled_start: startIso, repeat_interval: 1, repeat_unit: 'days',
        },
      } as never);
      expect(res.isError, res.content).toBe(false);
      const row = mockDb.current!.prepare('SELECT tz FROM work WHERE title = ?')
        .get(`unzoned-${zone}`) as { tz: string | null };
      expect(row?.tz ?? null).toBeNull();
    });
  }
});
