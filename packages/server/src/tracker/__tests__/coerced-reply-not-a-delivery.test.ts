// PHASE-2 T1 Step 3 — preserve-catalogue addition (research 21 §guards-missed):
// COERCED-REPLY-IS-NOT-A-DELIVERY (the spin-brake rule, commit d54cd1f).
//
// The requirement: when the ENGINE forces a reply — the spin brake ends the tool
// phase with a STOP order and the model then emits text — that reply is a STATUS
// UPDATE, not a delivery. It must never be recorded as the turn having answered
// its ticket, because a stamped "answered/delivered" is what stands the drive
// ladder down and what later closes work the user never received.
//
// WHERE THE REQUIREMENT LIVES TODAY — re-derived at HEAD 1ca2c91, not inherited:
//   d54cd1f's own mechanism is GONE. `loopBlockFiredThisTurn` had exactly TWO
//   occurrences in the whole tree — a declaration and its only write — and no
//   reader at all: its consumer was the going-idle `deliverable_shown` stamp,
//   deleted by the P2 drive-boundary demolition. Its docblock still described
//   that deleted consumer in the present tense, which is how a stale comment
//   outlives the thing it documents. Reported as a T1 finding and DELETED by
//   PHASE-2 T6 (C9, adjudication #3), with this file named as the guard that
//   makes the deletion safe rather than merely tidy.
//
//   The requirement is now carried by the TURN OUTCOME instead, and that is a
//   better home: loop.ts:9148 computes
//     `const outcome = toolPhaseEndedByRepeats ? 'brake' : answerRow ? 'answered' : …`
//   so a spin-braked turn can never be labelled 'answered', and
//   tracker/task-stamps.ts gates every answer/delivery stamp on
//   `input.outcome === 'answered'`. That is the live law, so that is what this
//   file tests — the behaviour against a real database, plus a conformance lock
//   on the ternary's ORDER (brake must be tested BEFORE answerRow; swap them and
//   a braked turn that also produced a reply row starts stamping deliveries).
import { describe, it, expect, beforeEach, vi } from 'vitest';
import Database from 'better-sqlite3';

const mockDb = { current: null as Database.Database | null };
vi.mock('../../db/connection.js', () => ({
  getDb: () => {
    if (!mockDb.current) throw new Error('test DB not initialized');
    return mockDb.current;
  },
}));
import { stampTasksAtTurnFinalize } from '../task-stamps.js';

import { createWorkTable, seedTrackerTask, ms } from '../../work/__tests__/work-fixture.js';
import { stampColumns } from '../../work/tracker-view.js';

const AGENT = 'agent-alpha';
const TURN = 4242;

beforeEach(() => {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE turn_artifacts (agent_id TEXT, turn_number INTEGER, kind TEXT, path TEXT, payload_json TEXT, delivered_at TEXT);
    CREATE TABLE deliveries (agent_id TEXT, turn_number INTEGER, channel TEXT, outcome TEXT);
  `);
  createWorkTable(db);
  seedTrackerTask(db, {
    id: 't-braked', agentId: AGENT, title: 'The work the user is waiting for',
    origin_turn: TURN, updated_at: ms('2026-07-28 07:00:00'),
  });
  // The turn genuinely produced a channel delivery AND an artifact. This is the
  // hard case: the engine has real receipts for the turn, and the ONLY thing
  // that makes them not-a-delivery-of-this-ticket is that the reply was coerced.
  db.prepare(`INSERT INTO deliveries VALUES (?, ?, 'imessage', 'delivered')`).run(AGENT, TURN);
  db.prepare(
    `INSERT INTO turn_artifacts VALUES (?, ?, 'file', '/tmp/report.md', NULL, '2026-07-28 08:00:00')`,
  ).run(AGENT, TURN);
  mockDb.current = db;
});

const ticket = () =>
  mockDb.current!.prepare(
    // T8c item 2: read through the shared stamp projection, the way production reads it.
    `SELECT w.id AS id, ${stampColumns('w')} FROM work w WHERE w.id = 't-braked'`,
  ).get() as Record<string, unknown>;

// PHASE-2 T8b: `last_answer_message_id` and `last_delivery_at` are GONE — enumerated at T8a
// as having exactly one production occurrence each (the COALESCE onto themselves in this
// file's writer), so migration `137` did not carry them and this task stopped writing them.
// The property under test is unchanged and is asserted on the columns that DO have readers:
// a braked turn records ACTIVITY (`last_activity_*`) and never an ANSWER (`last_answered_*`,
// `last_delivery_summary`).
describe('a spin-braked (engine-coerced) reply is STATUS, never a delivery', () => {
  it("outcome 'brake' records ACTIVITY but never an ANSWER stamp", () => {
    stampTasksAtTurnFinalize({
      agentId: AGENT, turnNumber: TURN, outcome: 'brake',
      answerMessageId: 'msg-the-coerced-reply', rootSourceMessageId: null,
      convKey: null, servedTaskId: null,
    });
    const t = ticket();
    // The turn is not hidden — the engine says it happened…
    expect(t.last_activity_turn).toBe(TURN);
    expect(t.last_activity_outcome).toBe('brake');
    // …but nothing about it counts as having ANSWERED the ticket, even though a
    // real reply id was passed in for this exact turn.
    expect(t.last_answered_turn).toBeNull();
    expect(t.last_answered_at).toBeNull();
  });

  // ── PREMISE CORRECTION, recorded rather than quietly assumed (PHASE-2 T1) ──
  // This clause was first written asserting that a braked turn stamps NO
  // delivery columns either. It went RED, and the RED was RIGHT: `hasDelivery`
  // in task-stamps.ts is derived from the turn's real `deliveries` /
  // `turn_artifacts` receipts and is deliberately INDEPENDENT of `answered`, so
  // a turn that genuinely handed a file over before the brake fired still
  // records that handover. That is OR2-correct — the engine may state what it
  // can point at — and the assertion was tuned, not the product.
  //
  // The guard the requirement actually needs is the CONJUNCTION at the consumer:
  // the close-out gate only pushes "this is finished, mark it complete" when
  // BOTH `last_answered_turn IS NOT NULL` AND `last_delivery_summary` are set
  // (agent/v2/loop.ts, the close-out gate's evidence consult). A braked turn
  // therefore cannot reach that push no matter how many receipts it has, and
  // THAT is what this clause locks.
  it('a braked turn can record a handover receipt but can NEVER satisfy the finished-work predicate', () => {
    stampTasksAtTurnFinalize({
      agentId: AGENT, turnNumber: TURN, outcome: 'brake',
      answerMessageId: 'msg-the-coerced-reply', rootSourceMessageId: null,
      convKey: null, servedTaskId: null,
    });
    const t = ticket();
    // The receipt is recorded (honest: a real delivery row exists for the turn).
    expect(t.last_delivery_summary).not.toBeNull();
    // The finished-work predicate the close-out gate uses is still FALSE.
    const enginesaysFinished = t.last_answered_turn !== null && !!t.last_delivery_summary;
    expect(enginesaysFinished).toBe(false);
  });

  it("the SAME turn under outcome 'answered' does stamp — so the brake is what withholds it", () => {
    stampTasksAtTurnFinalize({
      agentId: AGENT, turnNumber: TURN, outcome: 'answered',
      answerMessageId: 'msg-a-real-answer', rootSourceMessageId: null,
      convKey: null, servedTaskId: null,
    });
    const t = ticket();
    expect(t.last_answered_turn).toBe(TURN);
    expect(String(t.last_delivery_summary)).toContain('imessage');
  });

  it('a brake NEVER erases an earlier honest delivery stamp (COALESCE, not overwrite)', () => {
    stampTasksAtTurnFinalize({
      agentId: AGENT, turnNumber: TURN, outcome: 'answered',
      answerMessageId: 'msg-a-real-answer', rootSourceMessageId: null,
      convKey: null, servedTaskId: null,
    });
    stampTasksAtTurnFinalize({
      agentId: AGENT, turnNumber: TURN + 1, outcome: 'brake',
      answerMessageId: 'msg-the-coerced-reply', rootSourceMessageId: null,
      // tied by served ticket: TURN+1 is a different turn, so origin_turn no
      // longer matches and the stamper would otherwise skip the ticket entirely.
      convKey: null, servedTaskId: 't-braked',
    });
    const t = ticket();
    expect(t.last_answered_turn).toBe(TURN);
    expect(t.last_activity_outcome).toBe('brake'); // activity moves on, the answer does not
  });
});
