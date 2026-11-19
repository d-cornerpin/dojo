// ════════════════════════════════════════════════════════════════════════════════════════
// AN ENGINE CUT IS NOT THE MODEL'S SILENCE — C2 follow-up, ledgered since v3.1.26.
//
// ── THE DEFECT, AND IT IS A RECORD THAT LIES ─────────────────────────────────────────────────
// A turn that runs into the tool-loop cap is CUT OFF BY THE ENGINE. It writes
// `[System: This turn reached 75 tool calls. Starting a fresh turn to continue your work…]`,
// notes an engine checkpoint, schedules a self-continuation — and then falls through the SAME
// teardown as any other turn (`loop.ts:639-697` → `runFinalize` → `runTurnTeardown`).
//
// That teardown derives the exit reason from what it can see, and it cannot see the cap:
//
//     const exitReason = toolPhaseEndedBySpinBrake ? 'brake'
//       : answerRow ? 'answered' : parkedRow ? 'park' : handoffRow ? 'handoff'
//       : 'no_reply_intended';                         // ← the cap lands HERE
//
// So the record says **the model intended not to reply**, about a turn the model never got to
// finish. `no_reply_intended` is not a shrug in this codebase: `work/ask-settlement.ts`'s
// re-serve ladder treats a finalize with no delivery as the same question "served into the same
// silence", spends a rung, and at the bound STANDS THE ASK DOWN to `blocked` — which is the state
// the drain's `state = 'open'` queue stops picking up. Four engine cuts and the owner's ask stops
// being re-served, having never been answered and never been declined.
//
// ── MEASURED ON THE OWNER'S BODY, and the measurement is what makes this a record bug ────────
//   10,934 turns. FIVE exit reasons have EVER been written: answered 5,451 · no_reply_intended
//   3,977 · handoff 1,356 · park 117 · unknown 33.
//   `iteration_cap` — declared in the `TurnExitReason` union, CHECKed by the DB, and published in
//   the telemetry enum — HAS NEVER BEEN WRITTEN ONCE. Nor have `brake`, `identical_call`, `stop`,
//   `preempt`, `provider_error`, `stream_idle`, `abort`, `terminated`, `budget`,
//   `delegation_exit`, `compile_pending`. There is exactly ONE `finalizeTurn` call site in
//   production and it can emit five of the seventeen.
//   All 10 stand-downs to `blocked` on that body read `no_reply_intended`. Whether any was really
//   a cut is UNKNOWABLE FROM THE RECORD — which is the defect, not a mitigation.
//
// ── OWNER RULING 10(d), WHICH DECIDES THE DIRECTION ──────────────────────────────────────────
// Ambiguity about whether the owner was answered resolves toward ANSWERING AGAIN, never toward
// closing or parking. An engine cut is the purest form of that ambiguity: nobody decided anything.
//
// ── WHAT THIS FIX IS NOT ─────────────────────────────────────────────────────────────────────
// It does not touch the ladder's BOUND, and §3 is the clause that holds that line. The owner's
// other standing complaint is that agents REPEAT THEMSELVES, and the bound is what stops a
// question being served into genuine silence for ever. `blocked` is an OWED state the OPEN WORK
// surface renders — the stand-down is not a close. The defect is the ATTRIBUTION: the ladder was
// being handed the model's intent for turns where the engine, not the model, ended it.
// ════════════════════════════════════════════════════════════════════════════════════════

import { describe, it, expect, beforeEach, vi } from 'vitest';
import Database from 'better-sqlite3';

const mockDb: { current: Database.Database | null } = { current: null };

vi.mock('../../db/connection.js', async () => {
  const os = await import('node:os');
  const p = await import('node:path');
  return {
    getDb: () => {
      if (!mockDb.current) throw new Error('test DB not initialized');
      return mockDb.current;
    },
    closeDb: vi.fn(),
    getDbPath: () => p.join((process.env.DOJO_TEST_HOME_ROOT || os.tmpdir()), 'dojo-engine-cut-test', 'dojo.db'),
  };
});

import { runMigrations } from '../../db/migrations.js';
import { askIdForMessage, claimAsk, stampClaimingTurn } from '../store.js';
import { MAX_ASK_RE_SERVES, MAX_ENGINE_HAND_BACKS, RE_SERVE_MARKER, settleAsk } from '../ask-settlement.js';
import { insertMessage } from '../../memory/message-store.js';
import { turnExitReason } from '../exit-attribution.js';
const AGENT = 'asker';
const CONV = 'conv-dashboard';
const db = (): Database.Database => mockDb.current!;

const workFor = (messageId: string): Record<string, unknown> =>
  db().prepare('SELECT * FROM work WHERE id = ?').get(askIdForMessage(messageId)) as Record<string, unknown>;
const transitionsFor = (messageId: string): Array<{ to: string; reason: string }> =>
  (db().prepare(
    `SELECT payload FROM work_events WHERE work_id = ? AND kind = 'transition' ORDER BY id`,
  ).all(askIdForMessage(messageId)) as Array<{ payload: string }>)
    .map((r) => JSON.parse(r.payload) as { to: string; reason: string });
const countOf = (messageId: string, causes: string): number =>
  (db().prepare(
    `SELECT COUNT(*) AS n FROM work_events WHERE work_id = ? AND kind = 'audit'
       AND json_extract(payload, '$.marker') = ? AND COALESCE(json_extract(payload, '$.cause'), 'silence') IN (${causes})`,
  ).get(askIdForMessage(messageId), RE_SERVE_MARKER) as { n: number }).n;
/** The silence rungs; an engine cut spends the engine count instead (`cutsFor`). */
const rungsFor = (messageId: string): number => countOf(messageId, "'silence'");
const cutsFor = (messageId: string): number => countOf(messageId, "'cut', 'crash'");

/** The turn record the settlement reads. THE POINT OF THIS FILE is which word goes here. */
function seedTurn(turn: number, exitReason: string, answered = 0): void {
  db().prepare(
    `INSERT OR REPLACE INTO turns (agent_id, turn_number, started_at, ended_at, exit_reason, answered)
     VALUES (?, ?, datetime('now','-60 seconds'), datetime('now'), ?, ?)`,
  ).run(AGENT, turn, exitReason, answered);
}

function claimedAsk(messageId: string, turn: number): string {
  insertMessage({
    id: messageId, agentId: AGENT, role: 'user', content: 'Compare the three options and tell me which to buy',
    conversationId: CONV, channel: 'dashboard', senderId: 'owner', displayKind: 'user-text',
    lane: 'owner',
  } as never);
  claimAsk(askIdForMessage(messageId), AGENT);
  stampClaimingTurn(askIdForMessage(messageId), turn);
  return askIdForMessage(messageId);
}

const finalize = (messageId: string, turn: number): string =>
  settleAsk(askIdForMessage(messageId), { agentId: AGENT, turnNumber: turn, at: 'finalize' }).verdict;
const reclaim = (messageId: string, turn: number): void => {
  claimAsk(askIdForMessage(messageId), AGENT);
  stampClaimingTurn(askIdForMessage(messageId), turn);
};

beforeEach(() => {
  const d = new Database(':memory:');
  d.pragma('foreign_keys = ON');
  mockDb.current = d;
  runMigrations();
  d.pragma('foreign_keys = ON');
  d.prepare("INSERT INTO agents (id, name, classification, status) VALUES (?, 'A', 'sensei', 'idle')").run(AGENT);
  d.prepare(
    `INSERT INTO conversations (id, agent_id, channel, provider, counterparty_id)
     VALUES (?, ?, 'dashboard', 'dashboard', 'owner')`,
  ).run(CONV, AGENT);
});

// ════════════════════════════════════════════════════════════════════════════════════════
// §2 — THE LADDER CHARGES SILENCES, NOT CUTS.
// ════════════════════════════════════════════════════════════════════════════════════════

describe('§2 an engine-cut turn hands the ask back without spending a silence rung', () => {
  it('the cut hands it back OPEN, spends no silence rung, and spends the engine count', () => {
    claimedAsk('m-1', 1);
    seedTurn(1, 'iteration_cap');
    expect(finalize('m-1', 1)).toBe('reopened');
    expect(workFor('m-1').state).toBe('open');
    expect(rungsFor('m-1'), 'an engine cut is not a serve the model spent').toBe(0);
    expect(cutsFor('m-1')).toBe(1);
    expect(transitionsFor('m-1').at(-1)!.reason).toContain('the engine ended the turn (1, iteration_cap)');
  });

  it('cuts in a row never spend the silence ladder; the engine count stands it down after its own bound', () => {
    claimedAsk('m-1', 1);
    for (let i = 0; i < MAX_ENGINE_HAND_BACKS; i++) {
      seedTurn(1 + i, 'iteration_cap');
      expect(finalize('m-1', 1 + i), `cut ${i + 1}`).toBe('reopened');
      expect(workFor('m-1').state, `cut ${i + 1}`).toBe('open');
      reclaim('m-1', 2 + i);
    }
    expect(rungsFor('m-1')).toBe(0);
    seedTurn(1 + MAX_ENGINE_HAND_BACKS, 'iteration_cap');
    expect(finalize('m-1', 1 + MAX_ENGINE_HAND_BACKS)).toBe('held');
    expect(workFor('m-1').state).toBe('blocked');
  });

  it('every engine cut is counted on the engine group; a stop, a barge-in or a budget stop is nobody\'s failure', () => {
    for (const reason of ['iteration_cap', 'park', 'brake', 'abort', 'provider_error', 'stream_idle', 'terminated', 'identical_call']) {
      claimedAsk(`m-${reason}`, 1);
      seedTurn(1, reason);
      expect(finalize(`m-${reason}`, 1), reason).toBe('reopened');
      expect([rungsFor(`m-${reason}`), cutsFor(`m-${reason}`)], reason).toEqual([0, 1]);
    }
    for (const reason of ['stop', 'preempt', 'budget']) {
      claimedAsk(`m-${reason}`, 1);
      seedTurn(1, reason);
      expect(finalize(`m-${reason}`, 1), reason).toBe('reopened');
      expect([rungsFor(`m-${reason}`), cutsFor(`m-${reason}`)], reason).toEqual([0, 0]);
    }
  });

  it('a cut does not un-spend rungs a real silence already spent', () => {
    claimedAsk('m-1', 1);
    seedTurn(1, 'no_reply_intended');
    expect(finalize('m-1', 1)).toBe('reopened');
    expect(rungsFor('m-1')).toBe(1);
    reclaim('m-1', 2);
    seedTurn(2, 'iteration_cap');
    expect(finalize('m-1', 2)).toBe('reopened');
    expect(rungsFor('m-1'), 'still one: the cut added nothing and removed nothing').toBe(1);
  });
});

// ════════════════════════════════════════════════════════════════════════════════════════
// §3 — WHAT MUST NOT MOVE: THE ANTI-REPETITION HALF.
//
// The owner has TWO standing complaints and they pull opposite ways. §2 is the reset-shaped one;
// this is the other. A genuine silence still spends a rung and the bound still stands the ask
// down, because a question served into real silence four times is the spin the bound refuses.
// ════════════════════════════════════════════════════════════════════════════════════════

describe('§3 a genuine silence is charged exactly as it was', () => {
  it('`no_reply_intended` spends its rungs and STANDS DOWN at the bound', () => {
    claimedAsk('m-1', 1);
    for (let i = 0; i < MAX_ASK_RE_SERVES; i++) {
      seedTurn(1 + i, 'no_reply_intended');
      expect(finalize('m-1', 1 + i)).toBe('reopened');
      reclaim('m-1', 2 + i);
    }
    seedTurn(1 + MAX_ASK_RE_SERVES, 'no_reply_intended');
    expect(finalize('m-1', 1 + MAX_ASK_RE_SERVES)).toBe('held');
    const w = workFor('m-1');
    expect(w.state).toBe('blocked');
    expect(w.closed_at, 'held OWED, never closed').toBeNull();
    expect(w.result_delivery_id, 'and settled on nothing').toBeNull();
    expect(transitionsFor('m-1').at(-1)!.reason).toContain('re-serve stood down');
  });

  it('`answered` with no qualifying delivery still spends a rung', () => {
    // The turn says it answered and the evidence read disagrees — that is the model's claim
    // failing, not an engine cut, and it is a shape the owner's body has twice. It keeps today's
    // behaviour: charged, handed back, visible.
    claimedAsk('m-1', 1);
    seedTurn(1, 'answered', 1);
    expect(finalize('m-1', 1)).toBe('reopened');
    expect(rungsFor('m-1')).toBe(1);
  });

  it('NO TURN RECORD keeps today\'s behaviour exactly — the conservative direction', () => {
    // At a real finalize the row always exists (`finalizeTurn` runs before the settlement in the
    // same teardown). A missing row is a fixture or a crash, and inventing "it must have been a
    // cut" there would silently disarm the bound for every caller that does not write one.
    claimedAsk('m-1', 1);
    expect(finalize('m-1', 1)).toBe('reopened');
    expect(rungsFor('m-1')).toBe(1);
  });

  it('A CUT CANNOT STAND DOWN A ROW THE SILENCES ALREADY WALKED TO THE BOUND', () => {
    // MUTATION GAP, found by MC4 and closed here. Dropping `!engineCut` from the stand-down guard
    // survived every other clause: in a cut-only history no rung is ever spent, so `spent` never
    // reaches the bound and the branch is unreachable. The shape that CAN reach it is a MIXED
    // history — three genuine silences, then the engine cuts the fourth turn — and there the mutant
    // parks an ask on a turn the model never got to finish, which is the whole defect.
    claimedAsk('m-1', 1);
    for (let i = 0; i < MAX_ASK_RE_SERVES; i++) {
      seedTurn(1 + i, 'no_reply_intended');
      expect(finalize('m-1', 1 + i)).toBe('reopened');
      reclaim('m-1', 2 + i);
    }
    expect(rungsFor('m-1')).toBe(MAX_ASK_RE_SERVES);   // at the bound
    seedTurn(1 + MAX_ASK_RE_SERVES, 'iteration_cap');
    expect(finalize('m-1', 1 + MAX_ASK_RE_SERVES), 'the cut must not spend the last rung').toBe('reopened');
    expect(workFor('m-1').state).toBe('open');
    expect(transitionsFor('m-1').some((t) => t.to === 'blocked')).toBe(false);
    // And the very next SILENCE still stands it down: the bound is intact, only the cut is exempt.
    reclaim('m-1', 2 + MAX_ASK_RE_SERVES);
    seedTurn(2 + MAX_ASK_RE_SERVES, 'no_reply_intended');
    expect(finalize('m-1', 2 + MAX_ASK_RE_SERVES)).toBe('held');
    expect(workFor('m-1').state).toBe('blocked');
  });

  it('a NULL turn number is not a cut — the bound stays armed', () => {
    // MUTATION GAP (MC7). `turnNumber == null` reading as a cut disarms the ladder for every caller
    // that settles without a turn, and nothing else in this file passes null.
    claimedAsk('m-1', 1);
    expect(settleAsk(askIdForMessage('m-1'), {
      agentId: AGENT, turnNumber: null, at: 'finalize',
    }).verdict).toBe('reopened');
    expect(rungsFor('m-1')).toBe(1);
  });

  it('a classifier that CANNOT READ the record does not invent a cut', () => {
    // MUTATION GAP (MC8), and asserted on the CLASSIFIER rather than through the settlement: the
    // settlement's own evidence read joins `turns` too, so breaking that table throws before this
    // question is ever asked. The catch belongs to `turnExitReason`, so the clause belongs there.
    // The fail direction is load-bearing: failing OPEN would silently disarm the bound the first time
    // the read broke, and a broken read is exactly when nobody is watching.
    seedTurn(1, 'iteration_cap');
    expect(turnExitReason(AGENT, 1), 'readable and a cut').toBe('iteration_cap');
    db().exec('DROP TABLE turns');
    expect(turnExitReason(AGENT, 1), 'unreadable ⇒ no exit, read as silence, so the bound stays armed').toBeNull();
  });

  it('`unknown` is not read as a cut', () => {
    claimedAsk('m-1', 1);
    seedTurn(1, 'unknown');
    expect(finalize('m-1', 1)).toBe('reopened');
    expect(rungsFor('m-1'), 'an unclassified exit keeps the bound armed').toBe(1);
  });
});

// ════════════════════════════════════════════════════════════════════════════════════════
// §4 — THE SHAPE AS FILED: a promoted start-ack, then the cap.
//
// This is the road the round-4-era review named, and it is why the defect is reachable rather
// than theoretical. The engine PROMOTES the model's opening line into a delivery, so something
// was said to the person; `NOT_A_START_ACK` correctly refuses it as answer evidence; then the cap
// cuts the turn off. Every surface looks like it spoke, the ask is unanswered, and before this
// fix the ladder quietly walked it to `blocked`.
// ════════════════════════════════════════════════════════════════════════════════════════

describe('§4 the quick-ack road', () => {
  it('a promoted ack plus a cut, four times over, and the ask is STILL being served', () => {
    claimedAsk('m-1', 1);
    for (let i = 0; i <= MAX_ASK_RE_SERVES; i++) {
      const turn = 1 + i;
      // the promoted start-ack: a real delivery, whose message the engine stamped as the ack
      const msgId = `ack-${turn}`;
      db().prepare(
        `INSERT INTO messages (id, agent_id, conversation_id, role, content, turn_number,
                               created_at, channel, sender_id, display_kind, origin_intent)
         VALUES (?, ?, ?, 'assistant', 'On it — reading both files now.', ?,
                 (CAST(strftime('%s','now') AS INTEGER) * 1000), 'dashboard', 'owner',
                 'agent-text', 'engine_start_ack')`,
      ).run(msgId, AGENT, CONV, turn);
      db().prepare(
        `INSERT INTO deliveries (id, agent_id, turn_number, tool, channel, conversation_id,
                                 outcome, message_id, created_at)
         VALUES (?, ?, ?, 'auto-route', 'dashboard', ?, 'delivered', ?, datetime('now'))`,
      ).run(`d-${turn}`, AGENT, turn, CONV, msgId);
      seedTurn(turn, 'iteration_cap');

      expect(finalize('m-1', turn), `round ${i + 1}`).toBe('reopened');
      expect(workFor('m-1').state, `round ${i + 1}`).toBe('open');
      if (i < MAX_ASK_RE_SERVES) reclaim('m-1', turn + 1);
    }
    expect(workFor('m-1').state, 'still in circulation after four rounds of ack-then-cut').toBe('open');
    expect(rungsFor('m-1')).toBe(0);
    expect(transitionsFor('m-1').some((t) => t.to === 'blocked')).toBe(false);
  });
});
