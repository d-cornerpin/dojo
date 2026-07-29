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
//   d54cd1f's own mechanism is GONE. `loopBlockFiredThisTurn` still exists but
//   has exactly TWO occurrences in the whole tree (`git grep -n
//   loopBlockFiredThisTurn -- packages/server/src` → agent/v2/loop.ts:1836 the
//   declaration, agent/v2/loop.ts:6445 the only write). It has no reader: its
//   consumer was the going-idle `deliverable_shown` stamp, deleted by the P2
//   drive-boundary demolition (see the tombstone comment at loop.ts:5665-5685).
//   Its docblock at loop.ts:1830-1836 still describes that deleted consumer, so
//   the flag is dead code with a stale comment — reported as a T1 finding.
//
//   The requirement is now carried by the TURN OUTCOME instead, and that is a
//   better home: loop.ts:9148 computes
//     `const outcome = toolPhaseEndedBySpinBrake ? 'brake' : answerRow ? 'answered' : …`
//   so a spin-braked turn can never be labelled 'answered', and
//   tracker/task-stamps.ts gates every answer/delivery stamp on
//   `input.outcome === 'answered'`. That is the live law, so that is what this
//   file tests — the behaviour against a real database, plus a conformance lock
//   on the ternary's ORDER (brake must be tested BEFORE answerRow; swap them and
//   a braked turn that also produced a reply row starts stamping deliveries).
import { describe, it, expect, beforeEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const mockDb = { current: null as Database.Database | null };
vi.mock('../../db/connection.js', () => ({
  getDb: () => {
    if (!mockDb.current) throw new Error('test DB not initialized');
    return mockDb.current;
  },
}));

import { stampTasksAtTurnFinalize } from '../task-stamps.js';

const AGENT = 'agent-alpha';
const TURN = 4242;

beforeEach(() => {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE legacy_tasks (
      id TEXT PRIMARY KEY, assigned_to TEXT, status TEXT, title TEXT,
      project_id TEXT, step_number INTEGER, total_steps INTEGER,
      source_message_id TEXT, origin_conv_key TEXT, origin_turn INTEGER,
      updated_at TEXT DEFAULT '2026-07-28 07:00:00',
      last_activity_turn INTEGER, last_activity_at TEXT, last_activity_outcome TEXT,
      last_answered_turn INTEGER, last_answered_at TEXT, last_answer_message_id TEXT,
      last_delivery_at TEXT, last_delivery_summary TEXT
    );
    CREATE TABLE turn_artifacts (agent_id TEXT, turn_number INTEGER, kind TEXT, path TEXT, payload_json TEXT, delivered_at TEXT);
    CREATE TABLE deliveries (agent_id TEXT, turn_number INTEGER, channel TEXT, outcome TEXT);
  `);
  db.prepare(
    `INSERT INTO legacy_tasks (id, assigned_to, status, title, origin_turn)
     VALUES ('t-braked', ?, 'in_progress', 'The work the user is waiting for', ?)`,
  ).run(AGENT, TURN);
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
  mockDb.current!.prepare("SELECT * FROM legacy_tasks WHERE id = 't-braked'").get() as Record<string, unknown>;

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
    expect(t.last_answer_message_id).toBeNull();
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

  it('the close-out gate really does require BOTH halves (conformance)', () => {
    const srcRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
    const loop = fs.readFileSync(path.join(srcRoot, 'agent/v2/loop.ts'), 'utf8');
    expect(loop).toMatch(/st\.last_answered_turn !== null && st\.last_delivery_summary/);
  });

  it("the SAME turn under outcome 'answered' does stamp — so the brake is what withholds it", () => {
    stampTasksAtTurnFinalize({
      agentId: AGENT, turnNumber: TURN, outcome: 'answered',
      answerMessageId: 'msg-a-real-answer', rootSourceMessageId: null,
      convKey: null, servedTaskId: null,
    });
    const t = ticket();
    expect(t.last_answered_turn).toBe(TURN);
    expect(t.last_answer_message_id).toBe('msg-a-real-answer');
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
    expect(t.last_answer_message_id).toBe('msg-a-real-answer');
    expect(t.last_activity_outcome).toBe('brake'); // activity moves on, the answer does not
  });
});

// ── Conformance: the loop must keep producing 'brake' for a braked turn ──
// The DB test above is only meaningful while the loop actually LABELS a braked
// turn 'brake'. That label is one ternary, and its ORDER is the whole guard: put
// `answerRow` first and a braked turn that also persisted text becomes
// 'answered', which re-opens the exact class d54cd1f closed.
describe('turn-outcome conformance: brake outranks answered (loop.ts)', () => {
  const loopSrc = (): string => {
    const srcRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
    return fs.readFileSync(path.join(srcRoot, 'agent/v2/loop.ts'), 'utf8');
  };

  // PHASE-2 T2 renamed the variable (`outcome` -> `exitReason`) when the column split into
  // exit_reason + answered. THE REQUIREMENT IS UNCHANGED and is what this asserts: the brake
  // is tested BEFORE answerRow, so a braked turn that also persisted text never reads as
  // 'answered'. The rename is why the addresses moved; d54cd1f's class is why the order matters.
  it('the exit-reason ternary tests toolPhaseEndedBySpinBrake BEFORE answerRow', () => {
    const src = loopSrc();
    const idx = src.indexOf('const exitReason: TurnExitReason = ');
    expect(idx).toBeGreaterThan(-1);
    const ternary = src.slice(idx, idx + 260);
    expect(ternary).toMatch(/const exitReason: TurnExitReason = toolPhaseEndedBySpinBrake \? 'brake'/);
    const brakeAt = ternary.indexOf('toolPhaseEndedBySpinBrake');
    const answerAt = ternary.indexOf('answerRow ?');
    expect(answerAt).toBeGreaterThan(-1);
    expect(brakeAt).toBeLessThan(answerAt);
  });

  it('that same exit reason is what finalizeTurn and the ticket stamps both receive', () => {
    const src = loopSrc();
    const idx = src.indexOf('const exitReason: TurnExitReason = ');
    // The finalize call is the next statement after the ternary, so it stays a tight
    // window. The STAMP call is anchored to `finalizeTurn` instead of to a character
    // count: PHASE-2 T6 landed the turn-record's first reader between them (the closeout
    // enumeration and the waiting-on-owner disposition), and a fixed slice would have
    // turned "something else happens at the boundary now" into a failure about a
    // requirement that still holds. What the requirement actually says is ORDER and
    // ARGUMENT — the stamps run after finalize and receive the same outcome — so that is
    // what is asserted.
    expect(src.slice(idx, idx + 600)).toMatch(/finalizeTurn\(\s*agentId, turnNumber, exitReason/);
    const afterFinalize = src.slice(src.indexOf('finalizeTurn(\n', idx));
    const stampAt = afterFinalize.indexOf('stampTasksAtTurnFinalize({');
    expect(stampAt).toBeGreaterThan(-1);
    expect(afterFinalize.slice(stampAt, stampAt + 200)).toMatch(/outcome/);
  });

  // ...and the ANSWERED half is now its own recorded fact rather than a word to infer from.
  it('answered is passed as the truthful-answer key, not derived from the exit reason', () => {
    const src = loopSrc();
    const idx = src.indexOf('const exitReason: TurnExitReason = ');
    const block = src.slice(idx, idx + 1600);
    expect(block).toMatch(/finalizeTurn\([\s\S]{0,120}answerRow !== undefined/);
  });

  it('the ticket stamper still gates its answer/delivery columns on outcome === "answered"', () => {
    const srcRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
    const stamps = fs.readFileSync(path.join(srcRoot, 'tracker/task-stamps.ts'), 'utf8');
    expect(stamps).toMatch(/const answered = input\.outcome === 'answered';/);
  });
});
