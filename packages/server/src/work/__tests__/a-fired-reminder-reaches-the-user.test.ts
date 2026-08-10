// ════════════════════════════════════════════════════════════════════════════════
// UX-REPAIR ROUND 4 T19 — A FIRED REMINDER REACHES THE USER, PERIOD.
//
// ── THE INCIDENT (the owner's box, 2026-08-10 13:45Z, occurrence 8a981511) ──
// A reminder fired. A wake was written, a turn ran for 54 seconds, and the model WROTE the
// reminder text — twice. The owner heard nothing, and no platform arm ever told him. Four
// different functions on that box answer the question *"did a person receive something?"*
// with four different predicates, and the two facing the model and the owner are wrong in
// OPPOSITE directions:
//
//   `runDeliverableEvidence`   excludes chips           -> correct
//   `turnDeliveredToPerson`    NO chip exclusion        -> FALSE POSITIVE (D2): four
//                                                          `deliveries` rows written for the
//                                                          model's TOOL CALLS said "the owner
//                                                          has it" and suppressed the
//                                                          reminder-silence ghost
//   `composeTurnDeliverySummary` excludes 'dashboard'   -> FALSE NEGATIVE (D7, its own file)
//
// This file holds the four legs that live in `work/`:
//
//   D2  the receipt reader stops counting a tool-call chip as a person receiving something
//   D3  the deliver ladder can actually be exhausted — an in-turn burst is still ONE drive
//       (unchanged), but a TURN that ends undelivered on an already-steered run now spends
//       its rung at the turn boundary, so the honest stand-down is reachable
//   D4  a `failed` close of a run that OWED a person a message and reached nobody is recorded
//       UNDELIVERED, not silently neutral — the 30-minute idle reaper stops walking past the
//       deliverable authority
//   D6  a run that DELIVERED and was never steered gets closed on that delivery — the
//       complement of the steered arm, answered with evidence rather than with a steer
// ════════════════════════════════════════════════════════════════════════════════

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
    getDbPath: () => path.join(os.tmpdir(), 'dojo-t19-reminder-test', 'dojo.db'),
  };
});

import { runMigrations } from '../../db/migrations.js';
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

const AGENT = 'kevin';
const CONV = 'conv-1';
const W = 'sched-reminder';
const RUN_OPENED = 1786369522069; // 2026-08-10 13:45:22Z, the incident's own instant

const db = (): Database.Database => mockDb.current!;

function seedAgent(): void {
  db().prepare(
    `INSERT INTO agents (id, name, status, session_started_at)
     VALUES (?, 'Kevin', 'idle', '1970-01-01')`,
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
describe('D2 — the turn-receipt reader excludes the chips the platform already declared not-an-answer', () => {
  it('a receipt pointing at a TOOL-TURN row is not the owner receiving something (the incident)', () => {
    seedTurn(4602);
    deliverInRun('d-chip', 'tool-turn', 4602);
    expect(turnDeliveredToPerson(AGENT, 4602, CONV)).toBe(false);
  });

  it('a receipt pointing at a WORKING-NOTE row is not the owner receiving something', () => {
    seedTurn(4602);
    deliverInRun('d-note', 'working-note', 4602);
    expect(turnDeliveredToPerson(AGENT, 4602, CONV)).toBe(false);
  });

  it('CONTROL: a receipt pointing at the agent\'s own text still counts, byte-identically', () => {
    seedTurn(4621);
    deliverInRun('d-real', 'agent-text', 4621);
    expect(turnDeliveredToPerson(AGENT, 4621, CONV)).toBe(true);
  });

  it('CONTROL: a receipt with no message row behind it still counts (the channel doors write those)', () => {
    seedTurn(7);
    seedDelivery('d-bare', { turn_number: 7, message_id: null, tool: 'imessage', channel: 'imessage' });
    expect(turnDeliveredToPerson(AGENT, 7, CONV)).toBe(true);
  });

  it('the reader uses the DECLARED set, so it can never drift from the authority', async () => {
    const fs = await import('node:fs');
    const path = await import('node:path');
    const url = await import('node:url');
    const here = path.dirname(url.fileURLToPath(import.meta.url));
    const src = fs.readFileSync(path.resolve(here, '../../agent/v2/answered-edge.ts'), 'utf8');
    expect(src).toContain('NON_ANSWERING_DISPLAY_KINDS');
    // and it is not a second, retyped copy of the same two words
    const fn = src.slice(src.indexOf('export function turnDeliveredToPerson'));
    expect(fn.slice(0, 1200)).not.toContain("'working-note'");
    expect([...NON_ANSWERING_DISPLAY_KINDS].sort()).toEqual(['tool-turn', 'working-note']);
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// §2 — D3. THE LADDER CAN BE SPENT.
//
// `runDriveCount` counts DISTINCT TURNS and that is MEASURED, not designed (behavioral run
// `bmslqef2w3r`: four `complete` calls inside one turn burned the whole ladder in ten
// seconds). That rule stays. What it could not do is ADVANCE: the count only moved when the
// model attempted another close, so a model that stops calling the tool freezes the ladder
// at whatever rung it reached — the incident read `1 of 3`, `2 of 3`, `2 of 3` and stood
// down never. The turn BOUNDARY is the missing drive tick.
// ══════════════════════════════════════════════════════════════════════════════
describe('D3 — a turn that ends undelivered on a steered run spends its rung at the boundary', () => {
  beforeEach(() => {
    seedSchedule(W, 'reminder');
    declareDeliverableOnSchedule(W);
  });

  it('CONTROL (anti-burn, unchanged): three steers inside ONE turn are ONE drive', () => {
    const run = claim();
    for (const attempt of [1, 2, 3]) {
      recordRunDeliverSteer(run, {
        attempt, bound: MAX_RUN_DELIVER_STEERS, taskId: W, why: 'in-turn retry', turnNumber: 4602,
      });
    }
    expect(markerRows(run, RUN_DELIVER_STEER_MARKER)).toBe(3);
    expect(runDriveCount(run, RUN_DELIVER_STEER_MARKER)).toBe(1);
  });

  it('the turn boundary advances the ladder when the turn ends with nothing delivered', () => {
    const run = claim();
    recordRunDeliverSteer(run, {
      attempt: 1, bound: MAX_RUN_DELIVER_STEERS, taskId: W, why: 'close attempted', turnNumber: 4602,
    });
    seedTurn(4602); seedTurn(4603);
    // Turn 4602 ends undelivered: its own drive is already on the ledger, so nothing new.
    expect(advanceRunDeliverLadderAtTurnEnd(run, 4602).spent).toBe(false);
    expect(runDriveCount(run, RUN_DELIVER_STEER_MARKER)).toBe(1);
    // Turn 4603 ends undelivered too, and the model never called the tool again. TODAY the
    // ladder sits at 1 for ever; the boundary is the drive that was missing.
    expect(advanceRunDeliverLadderAtTurnEnd(run, 4603).spent).toBe(true);
    expect(runDriveCount(run, RUN_DELIVER_STEER_MARKER)).toBe(2);
  });

  it('reaching the bound at a turn boundary is where the STAND-DOWN becomes due', () => {
    const run = claim();
    recordRunDeliverSteer(run, {
      attempt: 1, bound: MAX_RUN_DELIVER_STEERS, taskId: W, why: 'close attempted', turnNumber: 4602,
    });
    seedTurn(4602); seedTurn(4603); seedTurn(4604);
    expect(advanceRunDeliverLadderAtTurnEnd(run, 4603).standDownDue).toBe(false);
    const last = advanceRunDeliverLadderAtTurnEnd(run, 4604);
    expect(runDriveCount(run, RUN_DELIVER_STEER_MARKER)).toBe(MAX_RUN_DELIVER_STEERS);
    expect(last.standDownDue).toBe(true);
    expect(last.taskId).toBe(W);
  });

  it('CONTROL: a run that was NEVER steered never burns a rung at a turn boundary', () => {
    const run = claim();
    seedTurn(4610);
    const r = advanceRunDeliverLadderAtTurnEnd(run, 4610);
    expect(r.spent).toBe(false);
    expect(r.standDownDue).toBe(false);
    expect(runDriveCount(run, RUN_DELIVER_STEER_MARKER)).toBe(0);
  });

  it('CONTROL: a turn that DELIVERED never burns a rung', () => {
    const run = claim();
    recordRunDeliverSteer(run, {
      attempt: 1, bound: MAX_RUN_DELIVER_STEERS, taskId: W, why: 'close attempted', turnNumber: 4602,
    });
    seedTurn(4603);
    deliverInRun('d-real', 'agent-text', 4603);
    expect(runDeliverableEvidence(run)).not.toBeNull();
    expect(advanceRunDeliverLadderAtTurnEnd(run, 4603).spent).toBe(false);
    expect(runDriveCount(run, RUN_DELIVER_STEER_MARKER)).toBe(1);
  });

  it('CONTROL: a chip-only turn is still an undelivered turn (D2\'s set, one owner)', () => {
    const run = claim();
    recordRunDeliverSteer(run, {
      attempt: 1, bound: MAX_RUN_DELIVER_STEERS, taskId: W, why: 'close attempted', turnNumber: 4602,
    });
    seedTurn(4603);
    deliverInRun('d-chip', 'tool-turn', 4603);
    expect(runDeliverableEvidence(run)).toBeNull();
    expect(advanceRunDeliverLadderAtTurnEnd(run, 4603).spent).toBe(true);
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// §3 — D4. A `failed` CLOSE STOPS WALKING PAST THE DELIVERABLE AUTHORITY.
//
// `settleOccurrence` applied the CT2 gate only inside `if (runStatus === 'complete')`, so
// the 30-minute idle reaper's `'failed'` close went straight past the one arm built for this
// incident class. The owner's run history then said *"assigned agent idle"* for a morning a
// reminder never reached him.
// ══════════════════════════════════════════════════════════════════════════════
describe('D4 — a failed close of a run that owed a person a message records UNDELIVERED', () => {
  it('the idle reaper\'s failed close on a deliverable-owing run with no delivery is UNDELIVERED', () => {
    seedSchedule(W, 'reminder');
    declareDeliverableOnSchedule(W);
    const run = claim();
    const s = settleOccurrence(run, 'failed', null, 'Auto-failed: assigned agent idle for 30+ minutes');
    expect(s.verdict).toBe('settled');
    expect(settledRunStatus(run)).toBe(RUN_STATUS_UNDELIVERED);
    expect(markerRows(run, RUN_DELIVER_STAND_DOWN_MARKER)).toBe(1);
  });

  it('CONTROL: a task that owes NOBODY a message still settles `failed`, byte-identically', () => {
    seedSchedule(W, null);
    const run = claim();
    settleOccurrence(run, 'failed', null, 'provider error');
    expect(settledRunStatus(run)).toBe('failed');
    expect(stateOf(run)).toBe('failed');
    expect(markerRows(run, RUN_DELIVER_STAND_DOWN_MARKER)).toBe(0);
  });

  it('CONTROL: a deliverable-owing run that DID deliver keeps the caller\'s `failed` word', () => {
    seedSchedule(W, 'reminder');
    declareDeliverableOnSchedule(W);
    const run = claim();
    seedTurn(4602);
    deliverInRun('d-real', 'agent-text', 4602);
    settleOccurrence(run, 'failed', null, 'the agent died after speaking');
    expect(settledRunStatus(run)).toBe('failed');
    expect(markerRows(run, RUN_DELIVER_STAND_DOWN_MARKER)).toBe(0);
  });

  it('CONTROL: `skipped` is untouched — a run that never ran owes no explanation', () => {
    seedSchedule(W, 'reminder');
    declareDeliverableOnSchedule(W);
    const run = claim();
    settleOccurrence(run, 'skipped', null, 'Skipped: the task was cancelled; schedule stopped');
    expect(settledRunStatus(run)).toBe('skipped');
    expect(markerRows(run, RUN_DELIVER_STAND_DOWN_MARKER)).toBe(0);
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// §4 — D6. NOTHING CLOSED A DELIVERED RUN THAT WAS NEVER STEERED.
//
// The verify rung requires a steer marker, and its header states the clause as load-bearing:
// *"the steer is the agent's own assertion that the work is finished … without it this sweep
// would be closing runs nobody said were done."* The complement — the model DELIVERS FIRST
// and never attempts a close at all — produces no marker and was uncovered. The driven
// reproduction landed exactly there: a perfectly delivered reminder sat `open` for twelve
// minutes and was heading for the 30-minute idle reaper. The worry is answered with
// EVIDENCE, which is stronger than the assertion it replaces.
// ══════════════════════════════════════════════════════════════════════════════
describe('D6 — a run closes on the delivery whether or not anybody steered it', () => {
  beforeEach(() => {
    seedSchedule(W, 'reminder');
    declareDeliverableOnSchedule(W);
  });

  it('an UNSTEERED run with a real delivery is ready to close (the driven repro)', () => {
    const run = claim();
    seedTurn(4621);
    deliverInRun('d-real', 'agent-text', 4621);
    const ready = runsReadyToCloseOnDelivery();
    expect(ready.map((r) => r.occurrenceId)).toContain(run);
    expect(ready.find((r) => r.occurrenceId === run)?.steered).toBe(false);
  });

  it('CONTROL: an unsteered run with NOTHING delivered is left alone', () => {
    claim();
    seedTurn(4621);
    expect(runsReadyToCloseOnDelivery()).toEqual([]);
  });

  it('CONTROL: an unsteered run whose only receipts are chips is left alone', () => {
    claim();
    seedTurn(4621);
    deliverInRun('d-chip', 'tool-turn', 4621);
    expect(runsReadyToCloseOnDelivery()).toEqual([]);
  });

  it('CONTROL: the STEERED arm still selects exactly what it always did', () => {
    const run = claim();
    recordRunDeliverSteer(run, {
      attempt: 1, bound: MAX_RUN_DELIVER_STEERS, taskId: W, why: 'close attempted', turnNumber: 4602,
    });
    seedTurn(4602);
    deliverInRun('d-real', 'agent-text', 4602);
    const ready = runsReadyToCloseOnDelivery();
    expect(ready.find((r) => r.occurrenceId === run)?.steered).toBe(true);
  });

  it('a run whose own turn is still RUNNING is not closed out from under it', () => {
    const run = claim();
    seedTurn(4621, { ended_at: null, exit_reason: null, root_id: run });
    deliverInRun('d-real', 'agent-text', 4621);
    expect(runsReadyToCloseOnDelivery().map((r) => r.occurrenceId)).not.toContain(run);
  });

  // ⚠ THE DRIVEN CATCH, PINNED. The first draft of the in-flight guard asked "does this AGENT
  // have any unended turn", and on the worn-in dev body that is permanently true: 22 unended
  // `turns` rows for one agent, 279 across seven, every one a turn some crash never closed. It
  // would have made this whole arm dead on arrival, silently. The guard is scoped to the RUN.
  it('an unrelated turn that a crash never closed does NOT freeze the arm for ever', () => {
    const run = claim();
    // a stranded row from some other work, months old, never ended
    seedTurn(1234, { ended_at: null, exit_reason: null, root_kind: 'ask', root_id: null });
    seedTurn(4621);
    deliverInRun('d-real', 'agent-text', 4621);
    expect(runsReadyToCloseOnDelivery().map((r) => r.occurrenceId)).toContain(run);
  });

  it('CONTROL: a task that owes nobody a message is never swept by this arm', () => {
    seedSchedule('sched-backup', null);
    const run = claim('sched-backup');
    seedTurn(4621);
    deliverInRun('d-real', 'agent-text', 4621);
    expect(runsReadyToCloseOnDelivery().map((r) => r.occurrenceId)).not.toContain(run);
  });
});
