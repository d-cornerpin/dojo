// ════════════════════════════════════════════════════════════════════════════
// THE CENSUS WIRE-THROUGHS, THROUGH THE DOOR. PHASE-6 T0C-W Step 1.
// RED-first: every ARM below failed at `1aa0fc4`, each naming its own dropped
// or unimplemented key. The PINs and NEGATIVE CONTROLS were green on both
// trees and are here to prove the fix took nothing away.
//
// ── WHY THE DOOR AND NOT THE INNER FUNCTION (the T0A seam pattern) ──────────
// `trackerCreateTask`, `reminderCreate` and `trackerEditTask` have supported
// `local_time` / `local_timezone` end to end since RC-18, and the exact-revert
// guard has read `revert_to_original` since RC-16. The defect T0C measured is
// one layer above them: the AGENT-FACING doors in `agent/tools/cat/tracker.ts`
// build a NEW args object and hand-pick which keys go through, and none of the
// three was on any pick list — while the tool's own success echo and its own
// refusal text told the model to pass them. A test written against the inner
// functions passes on the pre-fix tree and proves nothing. Every arm here goes
// through `trackerHandlers[...]`, the object the tool executor dispatches into.
//
// ── AND THE THIRD SEED IS NOT A WIRE-THROUGH AT ALL ─────────────────────────
// `filter:'overdue'` was DECLARED on `work_update`'s enum with no branch behind
// it: `work_update:list` tested `'mine'` and `'blocked'` and let everything else
// fall to `else`, which returns the UNFILTERED list. An agent asking for overdue
// work got every active row and no signal that its filter had been ignored.
// Inner support did not exist, so this arm is new behaviour — and the whole
// question was what "overdue" MEANS, answered in §RECONCILIATION below.
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
import { getAllToolDefinitions } from '../../agent/tools/definitions.js';
import { unknownArgsAgainstSchema } from '../../agent/tools/index.js';
import { wallToInstant } from '../../scheduler/engine.js';

const AGENT = 'a1';
const ORIGINAL_TZ = process.env.TZ;

/** Two box zones on opposite sides of UTC, so a sign error cannot pass both. */
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
    CREATE TABLE IF NOT EXISTS task_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT, task_id TEXT, agent_id TEXT,
      action TEXT, detail TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now'))
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

const rowOf = (id: string): Record<string, unknown> =>
  mockDb.current!.prepare(
    'SELECT title, description, original_description, scheduled_start, next_run_at, anchor_local FROM work WHERE id = ?',
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

// ════════════════════════════════════════════════════════════════════════════
// 1 · THE `local_time` TRIO — the engine's own hint, finally true
// ════════════════════════════════════════════════════════════════════════════
describe('seed 1 — local_time / local_timezone reach the tracker through the agent door', () => {
  for (const zone of ZONES) {
    it(`ARM create × ${zone}: a tz-less wall clock is resolved ENGINE-SIDE into scheduled_start`, async () => {
      process.env.TZ = zone;
      const res = await trackerHandlers['work_open:task']({
        agentId: AGENT,
        args: { kind: 'task', title: 'wall-clock create', goal: 'the wall clock lands', local_time: '2026-08-05T21:00' },
      } as never);
      expect(res.isError, `the create door refused: ${res.content}`).toBe(false);
      const row = mockDb.current!.prepare(
        "SELECT scheduled_start FROM work WHERE title = 'wall-clock create'",
      ).get() as { scheduled_start: number | null } | undefined;
      expect(row, 'the task was not created at all').toBeTruthy();
      expect(
        row!.scheduled_start,
        'the create door DROPPED `local_time`: the task carries no schedule at all, '
        + 'so the wall-clock conversion the tool advertises is unreachable through the door',
      ).toBe(wallToInstant(
        { year: 2026, month: 8, day: 5, hour: 21, minute: 0, second: 0 }, zone,
      ).getTime());
    });
  }

  it('ARM create: local_timezone overrides the box zone (the field is not silently ignored)', async () => {
    process.env.TZ = 'America/Los_Angeles';
    const res = await trackerHandlers['work_open:task']({
      agentId: AGENT,
      args: {
        kind: 'task', title: 'zoned create', goal: 'the zone is honoured',
        local_time: '2026-08-05T21:00', local_timezone: 'Asia/Tokyo',
      },
    } as never);
    expect(res.isError, `the create door refused: ${res.content}`).toBe(false);
    const row = mockDb.current!.prepare(
      "SELECT scheduled_start FROM work WHERE title = 'zoned create'",
    ).get() as { scheduled_start: number | null } | undefined;
    expect(
      row?.scheduled_start,
      'the create door dropped `local_timezone`: 21:00 resolved in the BOX zone rather than Tokyo',
    ).toBe(wallToInstant(
      { year: 2026, month: 8, day: 5, hour: 21, minute: 0, second: 0 }, 'Asia/Tokyo',
    ).getTime());
  });

  it('ARM reminder: the reminder door forwards the wall clock too', async () => {
    process.env.TZ = 'America/Los_Angeles';
    const res = await trackerHandlers['work_open:reminder']({
      agentId: AGENT,
      args: { kind: 'reminder', what: 'stand up', local_time: '2026-08-05T21:00' },
    } as never);
    expect(res.isError, `the reminder door refused: ${res.content}`).toBe(false);
    const row = mockDb.current!.prepare(
      "SELECT scheduled_start FROM work WHERE title LIKE 'Reminder:%'",
    ).get() as { scheduled_start: number | null } | undefined;
    expect(row, 'the reminder was not created').toBeTruthy();
    expect(
      row!.scheduled_start,
      'the reminder door DROPPED `local_time`: `reminderCreate` reads it and the door never hands it on, '
      + 'so the ASK_USER text that offers a wall clock names an unreachable field',
    ).toBe(wallToInstant(
      { year: 2026, month: 8, day: 5, hour: 21, minute: 0, second: 0 }, 'America/Los_Angeles',
    ).getTime());
  });

  it('ARM edit: a wall clock on EDIT moves the row — and the door no longer refuses it as "no editable field"', async () => {
    process.env.TZ = 'America/Los_Angeles';
    seedTrackerTask(mockDb.current!, {
      id: 'task-lt-edit', agentId: AGENT, title: 'edit me', status: 'on_deck',
      scheduled_start: Date.parse('2026-08-05T09:15:00.000Z'),
      schedule_status: 'waiting', next_run_at: Date.parse('2026-08-05T09:15:00.000Z'),
    });
    const res = await trackerHandlers['work_update:edit']({
      agentId: AGENT, args: { action: 'edit', task_id: 'task-lt-edit', local_time: '2026-08-05T21:00' },
    } as never);
    // THE NEGATIVE CONTROL IS THE DEFECT ITSELF, IN ONE LINE (T0A's shape): on the
    // pre-fix tree the door drops `local_time`, forwards nothing, and the inner
    // function answers "at least one editable field must be provided" — the tool
    // advertising a field and then denying it exists.
    expect(res.isError, `the edit door refused a wall-clock edit: ${res.content}`).toBe(false);
    expect(
      rowOf('task-lt-edit').scheduled_start,
      'the edit door DROPPED `local_time`',
    ).toBe(wallToInstant(
      { year: 2026, month: 8, day: 5, hour: 21, minute: 0, second: 0 }, 'America/Los_Angeles',
    ).getTime());
  });

  // ── NEGATIVE CONTROLS: green on BOTH trees ────────────────────────────────
  it('CONTROL: an explicit scheduled_start still WINS over local_time (precedence unchanged)', async () => {
    process.env.TZ = 'America/Los_Angeles';
    const res = await trackerHandlers['work_open:task']({
      agentId: AGENT,
      args: {
        kind: 'task', title: 'both given', goal: 'precedence holds',
        scheduled_start: '2026-08-05T03:00:00Z', local_time: '2026-08-05T21:00',
      },
    } as never);
    expect(res.isError, res.content).toBe(false);
    const row = mockDb.current!.prepare(
      "SELECT scheduled_start FROM work WHERE title = 'both given'",
    ).get() as { scheduled_start: number | null };
    expect(row.scheduled_start).toBe(Date.parse('2026-08-05T03:00:00Z'));
  });

  it('CONTROL: a task with NO wall clock and NO start is still created unscheduled', async () => {
    const res = await trackerHandlers['work_open:task']({
      agentId: AGENT, args: { kind: 'task', title: 'plain task', goal: 'nothing is scheduled' },
    } as never);
    expect(res.isError, res.content).toBe(false);
    const row = mockDb.current!.prepare(
      "SELECT scheduled_start FROM work WHERE title = 'plain task'",
    ).get() as { scheduled_start: number | null };
    expect(row.scheduled_start).toBeNull();
  });
});

// ════════════════════════════════════════════════════════════════════════════
// 2 · `revert_to_original` — the refusal's escape hatch, reachable
// ════════════════════════════════════════════════════════════════════════════
describe('seed 2 — revert_to_original reaches the exact-revert guard through the door', () => {
  const ORIGINAL = 'the original ask, written by the user';
  const LATER = 'a later edit that changed it';

  const seedEdited = (id: string): void => {
    seedTrackerTask(mockDb.current!, {
      id, agentId: AGENT, title: 'guarded', status: 'on_deck',
      description: LATER, original_description: ORIGINAL,
    });
  };

  it('CONTROL: WITHOUT the flag the guard still refuses — the protection is NOT weakened', async () => {
    seedEdited('task-rev-guard');
    const res = await trackerHandlers['work_update:edit']({
      agentId: AGENT, args: { action: 'edit', task_id: 'task-rev-guard', description: ORIGINAL },
    } as never);
    expect(res.isError, 'the byte-identical revert was allowed through with no flag').toBe(true);
    expect(res.content).toContain('ORIGINAL text byte-for-byte');
    expect(rowOf('task-rev-guard').description, 'the refused revert still wrote the row').toBe(LATER);
  });

  it('ARM: WITH revert_to_original=true the door forwards the flag and the revert lands', async () => {
    seedEdited('task-rev-ok');
    const res = await trackerHandlers['work_update:edit']({
      agentId: AGENT,
      args: {
        action: 'edit', task_id: 'task-rev-ok',
        description: ORIGINAL, revert_to_original: true,
      },
    } as never);
    expect(
      res.isError,
      'the edit door DROPPED `revert_to_original`: the guard never saw the acknowledgement, '
      + `so its own escape hatch is unreachable through the door. Refusal was: ${res.content}`,
    ).toBe(false);
    expect(rowOf('task-rev-ok').description).toBe(ORIGINAL);
  });

  it('CONTROL: the flag does not become a licence to edit — a normal edit is unaffected', async () => {
    seedEdited('task-rev-normal');
    const res = await trackerHandlers['work_update:edit']({
      agentId: AGENT,
      args: { action: 'edit', task_id: 'task-rev-normal', description: 'something else entirely' },
    } as never);
    expect(res.isError, res.content).toBe(false);
    expect(rowOf('task-rev-normal').description).toBe('something else entirely');
  });
});

// ════════════════════════════════════════════════════════════════════════════
// 3 · `filter:'overdue'` — declared for months, implemented here
//
// §RECONCILIATION. Two live meanings were enumerated at Step 0:
//   A · `scheduler/runner.ts` — a RECURRING task that has fired before and is
//       more than 1.5 × its interval late. Drives AUTO-PAUSE + wake the agent.
//   B · `tracker/pm-agent.ts` — any active waiting task more than 5 minutes
//       late. Drives an ADVISORY line in the PM's issue list.
// They are NOT two meanings of overdue. Each is the SAME base predicate plus
// its own noise floor for the action it takes — and runner.ts computes that
// base LITERALLY, as the `dueTasks` query it applies the 1.5× test on top of.
// The base is: next_run_at in the past · schedule_status 'waiting' · not paused.
// A list filter takes no action and escalates nothing, so it carries the base
// with NO threshold — which invents nothing, because both live sites already
// compute it. `dueScope()` is now that base's single declaration.
// ════════════════════════════════════════════════════════════════════════════
describe('seed 3 — filter:"overdue" answers the reconciled definition', () => {
  const NOW = Date.parse('2026-08-05T12:00:00.000Z');
  const MIN = 60_000;

  /** Boundary rows spanning BOTH live thresholds, so containment is measured. */
  function seedBoundaryRows(): void {
    const db = mockDb.current!;
    // past 2 min, waiting, not paused, one-shot -> BASE yes · A no · B no
    seedTrackerTask(db, {
      id: 'ovd-01', agentId: AGENT, title: 'past2m-oneshot', status: 'on_deck',
      schedule_status: 'waiting', is_paused: 0, next_run_at: NOW - 2 * MIN,
    });
    // past 10 min, one-shot -> BASE yes · A no · B YES
    seedTrackerTask(db, {
      id: 'ovd-02', agentId: AGENT, title: 'past10m-oneshot', status: 'on_deck',
      schedule_status: 'waiting', is_paused: 0, next_run_at: NOW - 10 * MIN,
    });
    // past 200 min, hourly, has fired -> BASE yes · A YES · B YES
    seedTrackerTask(db, {
      id: 'ovd-03', agentId: AGENT, title: 'past200m-hourly-run3', status: 'on_deck',
      schedule_status: 'waiting', is_paused: 0, next_run_at: NOW - 200 * MIN,
      repeat_interval: 1, repeat_unit: 'hours', attempts: 3,
    });
    // paused schedule -> BASE no
    seedTrackerTask(db, {
      id: 'ovd-04', agentId: AGENT, title: 'past200m-paused', status: 'on_deck',
      schedule_status: 'paused', is_paused: 1, next_run_at: NOW - 200 * MIN,
    });
    // future -> BASE no
    seedTrackerTask(db, {
      id: 'ovd-05', agentId: AGENT, title: 'future', status: 'on_deck',
      schedule_status: 'waiting', is_paused: 0, next_run_at: NOW + 60 * MIN,
    });
    // never scheduled -> BASE no
    seedTrackerTask(db, {
      id: 'ovd-06', agentId: AGENT, title: 'unscheduled', status: 'on_deck',
      schedule_status: 'unscheduled', is_paused: 0, next_run_at: null,
    });
    // THE DIVERGENCE ROW: is_paused=1 while schedule_status is still 'waiting'
    // (`work/tracker-store.ts` syncSchedulePause writes the flag without the
    // status). runner.ts excludes it via is_paused; pm-agent excludes it via its
    // own active-status filter. Both agree — through different mechanisms — and
    // the filter must agree too, which is why the base carries BOTH clauses.
    seedTrackerTask(db, {
      id: 'ovd-07', agentId: AGENT, title: 'statepaused-schedwaiting', status: 'paused',
      schedule_status: 'waiting', is_paused: 1, next_run_at: NOW - 200 * MIN,
    });
  }

  beforeEach(() => {
    seedBoundaryRows();
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
  });
  afterAll(() => { vi.useRealTimers(); });

  it('ARM: filter="overdue" returns ONLY the overdue rows — it no longer silently returns everything', async () => {
    const res = await trackerHandlers['work_update:list']({
      agentId: AGENT, args: { action: 'list', filter: 'overdue' },
    } as never);
    expect(res.isError, res.content).toBe(false);
    // The three that are past-due, waiting and unpaused.
    expect(res.content, 'an overdue row is missing').toContain('past2m-oneshot');
    expect(res.content, 'an overdue row is missing').toContain('past10m-oneshot');
    expect(res.content, 'an overdue row is missing').toContain('past200m-hourly-run3');
    // And the four that are not. On the pre-fix tree `filter:"overdue"` fell to
    // the `else` branch and returned the WHOLE active list, so each of these
    // names the unimplemented enum value.
    expect(res.content, 'a PAUSED schedule was reported overdue').not.toContain('past200m-paused');
    expect(res.content, 'a FUTURE run was reported overdue').not.toContain('future');
    expect(res.content, 'an UNSCHEDULED task was reported overdue').not.toContain('unscheduled');
    expect(
      res.content,
      'the divergence row (is_paused=1, schedule_status="waiting") was reported overdue — '
      + 'the base predicate is missing one of its two paused clauses',
    ).not.toContain('statepaused-schedwaiting');
  });

  it('ARM: the answer NAMES the filter, so an ignored filter can never look like an empty board', async () => {
    const res = await trackerHandlers['work_update:list']({
      agentId: AGENT, args: { action: 'list', filter: 'overdue' },
    } as never);
    expect(res.content.toLowerCase(), 'the rendering does not say what it filtered to').toContain('overdue');
  });

  it('RECONCILIATION: both live meanings are SUBSETS of the filter\'s base, measured on the boundary rows', () => {
    const db = mockDb.current!;
    const rows = db.prepare(`
      SELECT id, next_run_at, schedule_status, is_paused, state,
             repeat_interval, repeat_unit, attempts AS run_count
        FROM work WHERE id LIKE 'ovd-%'
    `).all() as Array<Record<string, number | string | null>>;
    const intervalMs = (u: string | null, n: number | null): number | null =>
      !u || !n ? null : u === 'hours' ? n * 3_600_000 : u === 'minutes' ? n * 60_000 : null;

    const base = new Set<string>();
    const meaningA = new Set<string>();   // runner.ts — missed runs
    const meaningB = new Set<string>();   // pm-agent.ts — the advisory
    for (const r of rows) {
      const id = r.id as string;
      const nr = r.next_run_at as number | null;
      if (nr === null) continue;
      const late = NOW - nr;
      const isBase = nr <= NOW && r.schedule_status === 'waiting' && r.is_paused === 0;
      if (isBase) base.add(id);
      const iv = intervalMs(r.repeat_unit as string | null, r.repeat_interval as number | null);
      if (isBase && iv && (r.run_count as number) > 0 && late > iv * 1.5) meaningA.add(id);
      if (nr <= NOW && r.schedule_status === 'waiting'
          && late > 5 * MIN && r.state !== 'paused') meaningB.add(id);
    }
    // Neither live site selects a row the base does not. That containment IS the
    // reconciliation: the thresholds belong to the ACTIONS, not to the word.
    expect([...meaningA].filter((id) => !base.has(id)), 'runner.ts selects outside the base').toEqual([]);
    expect([...meaningB].filter((id) => !base.has(id)), 'pm-agent.ts selects outside the base').toEqual([]);
    // Non-vacuity: all three sets are non-empty and A ⊊ B ⊊ base on these rows,
    // so the containment is a measurement and not an accident of an empty seed.
    expect(base.size).toBe(3);
    expect(meaningB.size).toBe(2);
    expect(meaningA.size).toBe(1);
  });

  // ── NEGATIVE CONTROLS: green on BOTH trees ────────────────────────────────
  it('CONTROL: filter="mine" and filter="blocked" still answer as they did', async () => {
    const mine = await trackerHandlers['work_update:list']({
      agentId: AGENT, args: { action: 'list', filter: 'mine' },
    } as never);
    expect(mine.isError, mine.content).toBe(false);
    expect(mine.content).toContain('past2m-oneshot');
    const blocked = await trackerHandlers['work_update:list']({
      agentId: AGENT, args: { action: 'list', filter: 'blocked' },
    } as never);
    expect(blocked.isError, blocked.content).toBe(false);
    expect(blocked.content).toContain('blocked');
  });

  it('CONTROL: the default (no filter) still returns the whole active board', async () => {
    const res = await trackerHandlers['work_update:list']({
      agentId: AGENT, args: { action: 'list' },
    } as never);
    expect(res.isError, res.content).toBe(false);
    expect(res.content).toContain('past2m-oneshot');
    expect(res.content, 'the unfiltered list stopped showing a future task').toContain('future');
  });
});

// ════════════════════════════════════════════════════════════════════════════
// 4 · THE DECLARATION SURFACE — the unknown-arg warning knows them BY
//     CONSTRUCTION (it reads `input_schema.properties` at runtime), so this
//     drives the real function rather than asserting a source line.
// ════════════════════════════════════════════════════════════════════════════
describe('the declared surface, driven', () => {
  const DEFS = new Map(getAllToolDefinitions().map((d) => [d.name, d]));
  const propsOf = (tool: string): Record<string, unknown> =>
    (DEFS.get(tool)!.input_schema as { properties: Record<string, unknown> }).properties;

  it('work_open declares local_time and local_timezone', () => {
    const p = propsOf('work_open');
    expect(Object.keys(p)).toContain('local_time');
    expect(Object.keys(p)).toContain('local_timezone');
  });

  it('work_update declares local_time, local_timezone and revert_to_original', () => {
    const p = propsOf('work_update');
    expect(Object.keys(p)).toContain('local_time');
    expect(Object.keys(p)).toContain('local_timezone');
    expect(Object.keys(p)).toContain('revert_to_original');
  });

  it('the unknown-argument warning no longer fires on any of them', () => {
    const openExtras = unknownArgsAgainstSchema('work_open', {
      kind: 'task', title: 't', local_time: '2026-08-05T21:00', local_timezone: 'Asia/Tokyo',
    }).extras;
    expect(openExtras, `work_open still warns on: ${openExtras.join(', ')}`).toEqual([]);
    const updExtras = unknownArgsAgainstSchema('work_update', {
      action: 'edit', task_id: 'x', local_time: '2026-08-05T21:00',
      local_timezone: 'Asia/Tokyo', revert_to_original: true,
    }).extras;
    expect(updExtras, `work_update still warns on: ${updExtras.join(', ')}`).toEqual([]);
  });

  it('`tz` is DELIBERATELY not declared — the alias is retired at the door, kept at the read', () => {
    // The RULING, pinned so it stays a decision: `tz` is a pure alias for
    // `local_timezone` with no capability of its own. Declaring a SECOND spelling
    // of one field costs wire bytes in the cached prefix on every turn forever and
    // buys the model nothing the canonical name does not already give it. The READ
    // (`args.local_timezone ?? args.tz`) STAYS: HTTP callers already spell it `tz`
    // and deleting the read would narrow what works today (#15). So the agent door
    // advertises exactly one name for one field, and nothing that works stops.
    for (const tool of ['work_open', 'work_update']) {
      expect(Object.keys(propsOf(tool)), `${tool} declares the retired \`tz\` alias`).not.toContain('tz');
    }
    const extras = unknownArgsAgainstSchema('work_update', { action: 'edit', tz: 'Asia/Tokyo' }).extras;
    expect(extras, 'the retirement is silent — an agent passing `tz` must still be told').toEqual(['tz']);
  });
});
