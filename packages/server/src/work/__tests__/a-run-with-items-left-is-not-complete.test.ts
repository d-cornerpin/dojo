// v3.5 DONE IS MEASURED, fix round 3 (NB3) — the engine's own RUN closes go through the measure:
// \`closeRunsThatDelivered\` (the scheduler closes a run on its delivery) and the deliver-ladder
// stand-down (\`onTaskRunComplete\` from the turn boundary). A run that ends with items left is
// never recorded \`complete\`: it settles in the existing honest non-complete terminal (the
// occurrence \`abandoned\`, its run word \`incomplete\`), the remainder is on the task's record, and
// the schedule ADVANCES so the next run fires.
import { describe, it, expect, beforeEach, vi } from 'vitest';
import Database from 'better-sqlite3';

const mockDb: { current: Database.Database | null } = { current: null };

vi.mock('../../db/connection.js', async () => {
  const os = await import('node:os');
  const path = await import('node:path');
  return {
    getDb: () => {
      if (!mockDb.current) throw new Error('test DB not initialized');
      return mockDb.current;
    },
    closeDb: vi.fn(),
    getDbPath: () => path.join((process.env.DOJO_TEST_HOME_ROOT || os.tmpdir()), 'dojo-measured-run-close', 'dojo.db'),
  };
});

const { warns } = vi.hoisted(() => ({ warns: [] as string[] }));
vi.mock('../../logger.js', async (orig) => {
  const real = await orig<typeof import('../../logger.js')>();
  return { ...real, createLogger: (name: string) => { const l = real.createLogger(name); return { ...l, warn: (msg: string, ...rest: unknown[]) => { warns.push(msg); return (l.warn as (...a: unknown[]) => void)(msg, ...rest); } }; } };
});
vi.mock('../../gateway/ws.js', () => ({ broadcast: () => {}, stampPersistedRow: (e: unknown) => e }));
const { countMeasure } = vi.hoisted(() => ({ countMeasure: vi.fn() }));
vi.mock('../measure.js', async (orig) => ({ ...(await orig<typeof import('../measure.js')>()), countMeasure }));
vi.mock('../../agent/access/read.js', async (orig) => ({ ...(await orig<typeof import('../../agent/access/read.js')>()), toolCategoryGranted: () => true }));

import { runMigrations } from '../../db/migrations.js';
import { closeRunsThatDelivered, onTaskRunComplete, forceResetStuckRecurringTask } from '../../scheduler/runner.js';
import { turnDeliveredToPerson } from '../../agent/v2/answered-edge.js';
import { NON_ANSWERING_DISPLAY_KINDS } from '../ask-settlement.js';
import {
  claimOccurrence, settleOccurrence, runDeliverableEvidence,
  advanceRunDeliverLadderAtTurnEnd, runsReadyToCloseOnDelivery,
  OCCURRENCE_EVENT,
} from '../occurrences.js';
import { declareDeliverableOnSchedule } from '../deliverable-declaration.js';
import { seedTrackerTask } from './work-fixture.js';
import {
  MAX_RUN_DELIVER_STEERS, RUN_STATUS_UNDELIVERED, RUN_DELIVER_STEER_MARKER,
  RUN_DELIVER_STAND_DOWN_MARKER, recordRunDeliverSteer, runDriveCount,
} from '../run-deliver-drive.js';

const AGENT = 'zargo';
const CONV = 'conv-1';
const W = 'sched-reminder';
const RUN_OPENED = 1786369522069; // 2026-08-10 13:45:22Z, the incident's own instant

const db = (): Database.Database => mockDb.current!;

function seedAgent(): void {
  db().prepare(
    `INSERT INTO agents (id, name, status, session_started_at)
     VALUES (?, 'Zargo', 'idle', '1970-01-01')`,
  ).run(AGENT);
  db().prepare(
    `INSERT INTO conversations (id, agent_id, channel, provider, counterparty_id, created_at)
     VALUES (?, ?, 'dashboard', NULL, 'owner', datetime('now'))`,
  ).run(CONV, AGENT);
}

function seedTurn(turnNumber: number, over: Record<string, unknown> = {}): void {
  const row = {
    agent_id: AGENT, turn_number: turnNumber, kind: 'engine', subject_kind: 'engine_event',
    subject_id: null, root_kind: 'occurrence', root_id: null, source_message_id: null,
    conv_key: 'owner', started_at: new Date().toISOString(), ended_at: new Date().toISOString(),
    exit_reason: 'no_reply_intended', answered: 0, effectful_calls: 0,
    answer_message_id: null, lane: null,
    ...over,
  };
  const cols = Object.keys(row);
  db().prepare(
    `INSERT INTO turns (${cols.join(', ')}) VALUES (${cols.map((c) => '@' + c).join(', ')})`,
  ).run(row);
}

/** A message row of a declared display kind — the thing a delivery receipt points AT. */
function seedMessage(id: string, displayKind: string, content = 'routine.'): string {
  db().prepare(
    `INSERT INTO messages (id, agent_id, conversation_id, lane, role, content, channel,
                           sender_id, authorized, created_at, provenance, display_kind, display_tier)
     VALUES (?, ?, ?, 'owner', 'assistant', ?, 'dashboard', NULL, 1, ?, 'live', ?, 'user-visible')`,
  ).run(id, AGENT, CONV, content, Date.now(), displayKind);
  return id;
}

/** A delivery row, written the way the transport doors write it (PHASE-2 T5). */
function seedDelivery(id: string, over: Record<string, unknown> = {}): string {
  const row = {
    id, agent_id: AGENT, turn_number: 1, tool: 'dashboard', channel: 'dashboard',
    recipient_id: 'owner', recipient_display: null, conversation_id: CONV,
    root_kind: null, root_id: null, message_id: null, receipt_id: null,
    outcome: 'delivered', detail: null,
    ...over,
  };
  const cols = Object.keys(row);
  db().prepare(
    `INSERT INTO deliveries (${cols.join(', ')}, created_at, updated_at)
     VALUES (${cols.map((c) => '@' + c).join(', ')}, datetime('now'), datetime('now'))`,
  ).run(row);
  return id;
}

/** The schedule row. `task_kind` is the DECLARED deliverable question and nothing else. */
function seedSchedule(id: string, taskKind: string | null): void {
  seedTrackerTask(db(), {
    id, title: 'Reminder: routine', status: 'on_deck', agentId: AGENT,
    description: 'routine', opened_at: RUN_OPENED - 1000, updated_at: RUN_OPENED - 1000,
    schedule_status: 'waiting', next_run_at: RUN_OPENED, repeat_interval: 1,
    repeat_unit: 'days', is_paused: 0, task_kind: taskKind,
  });
}

const claim = (workId = W): string => claimOccurrence({
  workId, sequence: 1, occurrenceMs: RUN_OPENED,
  nowMs: RUN_OPENED + 1, nextRunMs: RUN_OPENED + 86_400_000, agentId: AGENT,
})!;

const settledRunStatus = (id: string): string | null => {
  const r = db().prepare(
    `SELECT json_extract(payload, '$.run_status') AS s FROM work_events
      WHERE work_id = ? AND kind = ? ORDER BY id DESC LIMIT 1`,
  ).get(id, OCCURRENCE_EVENT.settled) as { s: string | null } | undefined;
  return r?.s ?? null;
};

const stateOf = (id: string): string =>
  (db().prepare('SELECT state FROM work WHERE id = ?').get(id) as { state: string }).state;

const markerRows = (id: string, marker: string): number =>
  (db().prepare(
    `SELECT COUNT(*) AS n FROM work_events
      WHERE work_id = ? AND kind = 'audit' AND json_extract(payload, '$.marker') = ?`,
  ).get(id, marker) as { n: number }).n;

/** A delivery INSIDE the run's window, pointing at a row of the given display kind. */
function deliverInRun(id: string, displayKind: string, turnNumber: number): void {
  const msg = seedMessage(`m-${id}`, displayKind);
  seedDelivery(id, { message_id: msg, turn_number: turnNumber });
}

beforeEach(() => {
  const fresh = new Database(':memory:');
  fresh.pragma('foreign_keys = ON');
  mockDb.current = fresh;
  runMigrations();
  fresh.pragma('foreign_keys = ON');
  seedAgent();
});

// ══════════════════════════════════════════════════════════════════════════════
// §1 — D2. A TOOL-CALL CHIP IS NOT A PERSON RECEIVING SOMETHING.
//
// The set already exists and is documented as deliberate (`ask-settlement.ts`:
// *"A working note is a bubble the PLATFORM ITSELF has already declared not to be the
// answer … without this entry an ask could be closed on a receipt pointing at a row the
// platform has on record as drafting."*). `turnDeliveredToPerson` simply never imported it,
// and its own header claims the opposite of what it does — *"the honest question is 'is
// there a delivery on the ledger for this turn'"*.
// ══════════════════════════════════════════════════════════════════════════════

const MEASURE = JSON.stringify({ tool: 'gmail_search', args: { query: 'in:inbox -label:Done' }, unit: 'messages' });
const measure = (left: number): void => {
  db().prepare('UPDATE work SET measure_json = ?, measure_initial = 50, measure_remaining = ?, measure_at = ?, scheduled_start = ? WHERE id = ?').run(MEASURE, left, RUN_OPENED, RUN_OPENED - 86_400_000, W);
};
const nextRunOf = (): { next: number | null; status: string } => db().prepare('SELECT next_run_at AS next, schedule_status AS status FROM work WHERE id = ?').get(W) as { next: number | null; status: string };
const remainderOnTask = (): string[] => (db().prepare("SELECT payload FROM work_events WHERE work_id = ? AND kind = 'audit'").all(W) as Array<{ payload: string }>)
  .map((r) => r.payload).filter((p) => p.includes('left by its measure'));

describe('a run that ends with items left is recorded incomplete, and the schedule moves on', () => {
  beforeEach(() => {
    seedSchedule(W, 'reminder');
    declareDeliverableOnSchedule(W);
    countMeasure.mockReset();
  });

  it('closeRunsThatDelivered re-reads the measure, records the run incomplete, keeps the remainder, and advances', async () => {
    measure(50);
    const run = claim();
    seedTurn(4621);
    deliverInRun('d-real', 'agent-text', 4621);
    countMeasure.mockResolvedValueOnce({ ok: true, count: 5 });
    const before = nextRunOf().next;
    expect(await closeRunsThatDelivered()).toBe(1);
    expect(countMeasure).toHaveBeenCalledTimes(1);
    expect(stateOf(run)).toBe('abandoned');
    expect(settledRunStatus(run)).toBe('incomplete');
    expect(remainderOnTask()).toEqual([expect.stringContaining('5 messages left by its measure')]);
    expect(nextRunOf().status).toBe('waiting');
    expect(nextRunOf().next).not.toBe(before);
  });

  it('CONTROL: at zero the delivered run is complete, exactly as before', async () => {
    measure(50);
    const run = claim();
    seedTurn(4621);
    deliverInRun('d-real', 'agent-text', 4621);
    countMeasure.mockResolvedValueOnce({ ok: true, count: 0 });
    expect(await closeRunsThatDelivered()).toBe(1);
    expect(stateOf(run)).toBe('done');
    expect(settledRunStatus(run)).toBe('complete');
  });

  it('the run authority itself (the stand-down\'s door, onTaskRunComplete "complete") never records complete with items left', async () => {
    measure(5);
    const run = claim();
    seedTurn(4621);
    deliverInRun('d-real', 'agent-text', 4621);
    expect(await onTaskRunComplete(W, 'complete', 'the deliver ladder stood down')).toBe(true);
    expect(stateOf(run)).toBe('abandoned');
    expect(settledRunStatus(run)).toBe('incomplete');
    expect(nextRunOf().status).toBe('waiting');
  });
});

describe('minor (b): a refused last-run close says what happened', () => {
  it('the stuck-row force-reset with no runs left, refused by the measure, never logs "marked complete" and does not touch the row again', () => {
    seedSchedule(W, null);
    // No anchor: the recurrence has no next run, which is the force-reset's "no future runs" arm.
    db().prepare("UPDATE work SET state = 'claimed', schedule_status = 'running', measure_json = ?, measure_remaining = 5, measure_at = ? WHERE id = ?").run(MEASURE, RUN_OPENED, W);
    warns.length = 0;
    forceResetStuckRecurringTask(W);
    expect(warns.some((w) => /marked complete/.test(w))).toBe(false);
    expect(warns.some((w) => /refused/.test(w))).toBe(true);
    expect(stateOf(W)).toBe('claimed');
    const touched = (db().prepare('SELECT updated_at AS u FROM work WHERE id = ?').get(W) as { u: number }).u;
    warns.length = 0;
    forceResetStuckRecurringTask(W);   // the 120-minute retry
    expect((db().prepare('SELECT updated_at AS u FROM work WHERE id = ?').get(W) as { u: number }).u).toBe(touched);
  });
});
