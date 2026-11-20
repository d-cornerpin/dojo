// v3.5 DONE IS MEASURED, fix round 3 (NB3) — the engine's own RUN closes go through the measure:
// \`closeRunsThatDelivered\` (the scheduler closes a run on its delivery) and \`onTaskRunComplete\`.
// A run that ends with items left is
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
vi.mock('../../agent/runtime.js', () => ({ getAgentRuntime: () => ({ handleMessage: async () => 'ran' }) }));
const { countMeasure } = vi.hoisted(() => ({ countMeasure: vi.fn() }));
vi.mock('../measure.js', async (orig) => ({ ...(await orig<typeof import('../measure.js')>()), countMeasure }));
vi.mock('../../agent/access/read.js', async (orig) => ({ ...(await orig<typeof import('../../agent/access/read.js')>()), toolCategoryGranted: () => true }));

import { runMigrations } from '../../db/migrations.js';
import { closeRunsThatDelivered, onTaskRunComplete, forceResetStuckRecurringTask } from '../../scheduler/runner.js';
import { turnDeliveredToPerson } from '../../agent/v2/answered-edge.js';
import { NON_ANSWERING_DISPLAY_KINDS } from '../ask-settlement.js';
import {
  claimOccurrence, settleOccurrence, runsReadyToCloseOnDelivery, RUN_STATUS_UNDELIVERED,
  OCCURRENCE_EVENT,
} from '../occurrences.js';
import { declareDeliverableOnSchedule } from '../deliverable-declaration.js';
import { listOccurrenceRuns } from '../occurrence-runs.js';
import { countOf } from '../measure-close-gate.js';
import { seedTrackerTask } from './work-fixture.js';
import { FX, FXID } from '../../../../../deploy/checks/fixture-vocabulary.mjs';

const AGENT = FXID.n4;
const CONV = 'conv-1';
const W = 'sched-reminder';
const RUN_OPENED = 1786369522069; // 2026-08-10 13:45:22Z, the incident's own instant

const db = (): Database.Database => mockDb.current!;

function seedAgent(): void {
  db().prepare(
    `INSERT INTO agents (id, name, status, session_started_at)
     VALUES (?, '${FX.n4}', 'idle', '1970-01-01')`,
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


/** A delivery INSIDE the run's window, pointing at a row of the given display kind. */
function deliverInRun(id: string, displayKind: string, turnNumber: number, run: string): void {
  const msg = seedMessage(`m-${id}`, displayKind);
  seedDelivery(id, { message_id: msg, turn_number: turnNumber, root_kind: 'occurrence', root_id: run });
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
    deliverInRun('d-real', 'agent-text', 4621, run);
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
    deliverInRun('d-real', 'agent-text', 4621, run);
    countMeasure.mockResolvedValueOnce({ ok: true, count: 0 });
    expect(await closeRunsThatDelivered()).toBe(1);
    expect(stateOf(run)).toBe('done');
    expect(settledRunStatus(run)).toBe('complete');
  });

  it('a run that DELIVERED, settled by the run authority (onTaskRunComplete "complete") with items left, is incomplete, not complete', async () => {
    measure(5);
    const run = claim();
    seedTurn(4621);
    deliverInRun('d-real', 'agent-text', 4621, run);
    expect(await onTaskRunComplete(W, 'complete', 'the deliver ladder stood down')).toBe(true);
    expect(stateOf(run)).toBe('abandoned');
    expect(settledRunStatus(run)).toBe('incomplete');
    expect(nextRunOf().status).toBe('waiting');
  });
});

describe('minor (b): a stuck schedule with no runs left and items left is handed in as can\'t be done', () => {
  it('the stuck-row force-reset with no runs left hands it in on its record, never done, and does not touch the row again', () => {
    seedSchedule(W, null);
    // No anchor: the recurrence has no next run, which is the force-reset's "no future runs" arm.
    db().prepare("UPDATE work SET state = 'claimed', schedule_status = 'running', measure_json = ?, measure_remaining = 5, measure_at = ? WHERE id = ?").run(MEASURE, RUN_OPENED, W);
    warns.length = 0;
    forceResetStuckRecurringTask(W);
    expect(warns.some((w) => /marked complete/.test(w))).toBe(false);
    expect(stateOf(W)).toBe('handed_in');
    expect((db().prepare("SELECT json_extract(payload, '$.outcome') AS o FROM work_events WHERE work_id = ? AND kind = 'handed_in'").get(W) as { o: string }).o).toBe('cant_be_done');
    const touched = (db().prepare('SELECT updated_at AS u FROM work WHERE id = ?').get(W) as { u: number }).u;
    warns.length = 0;
    forceResetStuckRecurringTask(W);   // the 120-minute retry
    expect((db().prepare('SELECT updated_at AS u FROM work WHERE id = ?').get(W) as { u: number }).u).toBe(touched);
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// THE DELIVERABLE GATE DECIDES FIRST. A run that owed a message and sent nothing is recorded
// UNDELIVERED with the owner's one alert, whatever the measure says. Only a run the gate would record
// COMPLETE becomes INCOMPLETE while items are left.
// ══════════════════════════════════════════════════════════════════════════════
const ghostRows = (): number => (db().prepare("SELECT COUNT(*) AS n FROM work_events WHERE kind = 'floor_ghosted'").get() as { n: number }).n;

describe('fix round 4: the deliverable gate decides before the measure', () => {
  beforeEach(() => {
    seedSchedule(W, 'reminder');
    declareDeliverableOnSchedule(W);
    countMeasure.mockReset();
  });

  it('owed a message, sent nothing, items left: UNDELIVERED, the owner\'s alert, and the schedule advances', async () => {
    measure(5);
    const run = claim();
    expect(await onTaskRunComplete(W, 'complete', 'the deliver ladder stood down')).toBe(true);
    expect(stateOf(run)).toBe('abandoned');
    expect(settledRunStatus(run)).toBe(RUN_STATUS_UNDELIVERED);
    expect(ghostRows()).toBe(1);
    expect(nextRunOf().status).toBe('waiting');
  });

  it('CONTROL at zero: the same run is UNDELIVERED with the alert', async () => {
    measure(0);
    const run = claim();
    expect(await onTaskRunComplete(W, 'complete', 'the deliver ladder stood down')).toBe(true);
    expect(settledRunStatus(run)).toBe(RUN_STATUS_UNDELIVERED);
    expect(ghostRows()).toBe(1);
  });
});

describe('fix round 4: the owner\'s run history reads an incomplete run as "Incomplete — N left", never "Skipped"', () => {
  it('status incomplete, the label names what is left, and it is not shown as an error', async () => {
    seedSchedule(W, 'reminder');
    declareDeliverableOnSchedule(W);
    measure(5);
    const run = claim();
    seedTurn(4621);
    deliverInRun('d-real', 'agent-text', 4621, run);
    expect(await onTaskRunComplete(W, 'complete', 'closed on that delivery')).toBe(true);
    const [row] = listOccurrenceRuns(W);
    expect(row.status).toBe('incomplete');
    expect(row.statusLabel).toBe('Incomplete — 5 messages left');
    expect(row.error).toBeNull();
  });

  it('one item left reads in the singular', async () => {
    seedSchedule(W, 'reminder');
    declareDeliverableOnSchedule(W);
    measure(1);
    const run = claim();
    seedTurn(4621);
    deliverInRun('d-real', 'agent-text', 4621, run);
    expect(await onTaskRunComplete(W, 'complete', 'closed on that delivery')).toBe(true);
    expect(listOccurrenceRuns(W)[0].statusLabel).toBe('Incomplete — 1 message left');
    expect(remainderOnTask()).toEqual([expect.stringContaining('A run ended with 1 message left')]);
  });
});

describe('a run close honours a hand-in filed in this run, whose door judged the measure', () => {
  beforeEach(() => {
    seedSchedule(W, null);
    countMeasure.mockReset();
  });
  // The `handed_in` event as the hand-in door writes it, after it judged the measure (a named remainder).
  const fileCloseRequest = (): void => {
    db().prepare("INSERT INTO work_events (work_id, kind, payload, actor, created_at) VALUES (?, 'handed_in', ?, ?, ?)")
      .run(W, JSON.stringify({ outcome: 'cant_be_done', items: [], note: 'the rest named', filedBy: AGENT, scope: 'run' }), AGENT, Date.now());
  };

  it('a hand-in filed during the run (the door judged it) settles the run complete', async () => {
    measure(5);
    const run = claim();
    fileCloseRequest();
    expect(await onTaskRunComplete(W, 'complete', 'handed in this run')).toBe(true);
    expect(settledRunStatus(run)).toBe('complete');
  });

  it('CONTROL: a hand-in filed BEFORE this run opened (event order) does not count', async () => {
    measure(5);
    fileCloseRequest();
    const run = claim();
    expect(await onTaskRunComplete(W, 'complete', 'swept')).toBe(true);
    expect(settledRunStatus(run)).toBe('incomplete');
  });
});

describe('fix round 4 (minor): one row that cannot be re-read never stops the delivered-run sweep', () => {
  it('the failing row is logged and left; the next row still closes', async () => {
    const W2 = 'sched-second';
    seedSchedule(W, 'reminder'); declareDeliverableOnSchedule(W);
    seedSchedule(W2, 'reminder'); declareDeliverableOnSchedule(W2);
    measure(5);
    db().prepare('UPDATE work SET measure_json = ?, measure_initial = 50, measure_remaining = 0, measure_at = ? WHERE id = ?').run(MEASURE, RUN_OPENED, W2);
    const run1 = claim(W); const run2 = claim(W2);
    seedTurn(4621);
    deliverInRun('d-real', 'agent-text', 4621, run1);
    seedTurn(4622);
    deliverInRun('d-real-2', 'agent-text', 4622, run2);
    countMeasure.mockReset();
    countMeasure.mockImplementation(async () => { throw new Error('counter blew up'); });
    warns.length = 0;
    const order = runsReadyToCloseOnDelivery().map((r) => r.taskId);
    expect(order.length).toBe(2);
    // the FIRST row the sweep meets throws; the second reads 0
    countMeasure.mockReset();
    countMeasure.mockRejectedValueOnce(new Error('counter blew up')).mockResolvedValueOnce({ ok: true, count: 0 });
    expect(await closeRunsThatDelivered()).toBe(1);
    expect(warns.some((w) => /re-reading a delivered run/.test(w))).toBe(true);
    const [first, second] = order[0] === W ? [run1, run2] : [run2, run1];
    expect(['open', 'claimed']).toContain(stateOf(first));
    expect(stateOf(second)).toBe('done');
  });
});

describe('fix round 6: a count reads in the singular only where the unit is a plural', () => {
  it.each([
    [1, 'boxes', '1 box'], [1, 'messages', '1 message'], [1, 'addresses', '1 address'], [1, 'batches', '1 batch'],
    [1, 'items', '1 item'], [2, 'boxes', '2 boxes'], [0, 'messages', '0 messages'],
  ])('%i %s -> %s', (n, unit, out) => {
    expect(countOf(n, unit)).toBe(out);
  });
});
