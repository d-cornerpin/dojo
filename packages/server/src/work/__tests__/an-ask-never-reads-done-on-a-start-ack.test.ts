// UX-REPAIR T2 — AN ASK NEVER READS DONE ON A START-ACK.
//
// THE SEVENTH NARROWING, and it is the same sentence a fourth time. `NON_ANSWERING_DELIVERY_TOOLS`
// said it about the `engine-ack` LANE, TB2 said it about a tool-call CHIP, CT0 said it about a
// superseded bubble AT THE TURN BOUNDARY. None of the three reaches the shape the owner's UX
// review caught: the model's own opening line, promoted mid-turn under the ordinary dashboard
// door, accepted as the ask's receipt while the work is still running. CT0's boundary arm
// REPAIRS that after the fact; between the two there is a window in which every machine reader
// is told the person has their answer.
//
// MEASURED THROUGH THE REAL DOOR before a line of the fix was written — dojo `ba49131`, dev
// server, floor model, BehaviorBot `57b52025`, one multistep request that read two files, wrote
// a summary and then answered:
//
//   turn 4526  ask:9eaab2ba
//     +0.00s  claimed                    (turn pickup)
//     +4.22s  done, receipt a6c01865 -> message eae6bdad "On it — reading both files now."
//                                        (assistant, owner lane, NO model_id, origin_intent NULL)
//     +11.97s ct0_receipt_repointed      -> c9a005dc -> "Done — summary written to t2-summary.txt…"
//     LYING WINDOW 7.754 s
//
// and the crash shape, killed between the ack and the answer (turn 4527, `ended_at IS NULL`,
// `answered=0`, `effectful_calls=0`): after the reboot the ask was STILL `done`, still receipted
// on "On it — reading both files now.", and nobody had ever been answered. The boot arms could
// not see it because the close had already NULLed `claimed_by_turn`.
//
// THE ENGINE KNEW AT THE INSTANT. `terminal-text.ts` sets `engineStartAckDeliveredThisTurn` two
// statements before it triggers the delivery, and the carrier for saying so — `origin_intent`,
// a persisted column with a parameter already threaded to it — was passed `null`. Stamping it is
// the fix; this file is the authority's half.
//
// WHAT THIS FILE DOES NOT WIDEN. The stamp is the ONLY new refusal. An unstamped bubble closes
// its ask at send time exactly as TB1 built it (ARM 1 below), CT0's boundary arm is untouched and
// still repairs the shapes the stamp cannot see (ARM 3), and a DIFFERENT `origin_intent` value is
// not refused (ARM 4) — the narrowing names one value, not the column.

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
    getDbPath: () => path.join(os.tmpdir(), 'dojo-t2-start-ack-test', 'dojo.db'),
  };
});

import { runMigrations } from '../../db/migrations.js';
import { askIdForMessage, claimAsk, stampClaimingTurn } from '../store.js';
import {
  settleAsk, settleAsksAtTurnFinalize, reconcileOrphanedClaims, askAnswerEvidence,
} from '../ask-settlement.js';
import { insertMessage } from '../../memory/message-store.js';

const AGENT = 'kevin';
const CONV = 'conv-1';

/** The stamp the engine puts on the promoted start line. One spelling, read from the product. */
const START_ACK_INTENT = 'engine_start_ack';

const workFor = (messageId: string): Record<string, unknown> =>
  mockDb.current!.prepare('SELECT * FROM work WHERE id = ?').get(askIdForMessage(messageId)) as
    Record<string, unknown>;
const receiptOf = (messageId: string): string | null =>
  workFor(messageId).result_delivery_id as string | null;
const transitionsFor = (messageId: string): Array<{ to: string; reason: string }> =>
  (mockDb.current!.prepare(
    `SELECT payload FROM work_events WHERE work_id = ? AND kind = 'transition' ORDER BY id`,
  ).all(askIdForMessage(messageId)) as Array<{ payload: string }>)
    .map((r) => JSON.parse(r.payload) as { to: string; reason: string });
const markersFor = (messageId: string): string[] =>
  (mockDb.current!.prepare(
    `SELECT payload FROM work_events WHERE work_id = ? ORDER BY id`,
  ).all(askIdForMessage(messageId)) as Array<{ payload: string }>)
    .map((r) => (JSON.parse(r.payload) as { marker?: string }).marker)
    .filter((m): m is string => !!m);

const ownerInbound = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  agentId: AGENT, role: 'user', content: 'can you compare those two files for me?',
  lane: 'owner', channel: 'dashboard', senderId: 'owner', authorized: true,
  conversationId: CONV,
  inboundMeta: JSON.stringify({ channel: 'dashboard', relation: 'owner' }),
  ...over,
});

/** An ask picked up by a turn. */
function claimedAsk(messageId: string, turn: number): string {
  insertMessage(ownerInbound({ id: messageId }) as never);
  claimAsk(askIdForMessage(messageId), AGENT);
  stampClaimingTurn(askIdForMessage(messageId), turn);
  return askIdForMessage(messageId);
}

/**
 * A user-visible assistant bubble and the delivery that carried it — the SHAPE the real door
 * produces. `originIntent` is what the fix stamps on the promoted start line; the driven RED
 * above shows today's production row with it NULL and `display_kind='agent-text'`, which is
 * exactly the row `originIntent: null` writes here.
 */
function bubbleDelivery(
  deliveryId: string, messageId: string, text: string,
  o: { turn?: number; offsetSeconds?: number; originIntent?: string | null; displayKind?: string } = {},
): void {
  const t = { turn: 4, offsetSeconds: 0, originIntent: null as string | null, displayKind: 'agent-text', ...o };
  mockDb.current!.prepare(
    `INSERT INTO messages (id, agent_id, role, content, lane, display_kind, display_tier,
                           origin_intent, conversation_id, turn_number, created_at)
     VALUES (?, ?, 'assistant', ?, 'owner', ?, 'user-visible', ?, ?, ?, ?)`,
  ).run(messageId, AGENT, text, t.displayKind, t.originIntent, CONV, t.turn,
    Date.now() + t.offsetSeconds * 1000);
  mockDb.current!.prepare(
    `INSERT INTO deliveries (id, agent_id, turn_number, tool, channel, conversation_id,
                             message_id, outcome, created_at)
     VALUES (?, ?, ?, 'dashboard', 'dashboard', ?, ?, 'delivered', datetime('now', ?))`,
  ).run(deliveryId, AGENT, t.turn, CONV, messageId, `${t.offsetSeconds} seconds`);
}

/** The promoted start line as the engine writes it AFTER this fix. */
const ackDelivery = (deliveryId: string, messageId: string, text: string, turn = 4): void =>
  bubbleDelivery(deliveryId, messageId, text, { turn, originIntent: START_ACK_INTENT });

/** The turn record as `finalizeTurnRecord` writes it, before the settlement runs. */
function finalizedTurn(n: number, answerMessageId: string | null): void {
  mockDb.current!.prepare(
    `INSERT OR REPLACE INTO turns (agent_id, turn_number, started_at, ended_at, exit_reason,
                                   answered, answer_message_id)
     VALUES (?, ?, datetime('now','-60 seconds'), datetime('now'), ?, ?, ?)`,
  ).run(AGENT, n, answerMessageId ? 'answered' : 'no_reply_intended', answerMessageId ? 1 : 0,
    answerMessageId);
}

/** A turn that started and never ended — the crash shape the boot arms adjudicate. */
function liveTurn(n: number, effectfulCalls = 0): void {
  mockDb.current!.prepare(
    `INSERT OR REPLACE INTO turns (agent_id, turn_number, started_at, ended_at, answered, effectful_calls)
     VALUES (?, ?, datetime('now','-30 seconds'), NULL, 0, ?)`,
  ).run(AGENT, n, effectfulCalls);
}

beforeEach(() => {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  mockDb.current = db;
  runMigrations();
  db.pragma('foreign_keys = ON');
  db.prepare(
    `INSERT INTO agents (id, name, status, session_started_at) VALUES (?, 'Kevin', 'idle', '1970-01-01')`,
  ).run(AGENT);
  db.prepare(
    `INSERT INTO conversations (id, agent_id, channel, counterparty_id) VALUES ('conv-1', ?, 'dashboard', 'owner')`,
  ).run(AGENT);
});

// ════════════════════════════════════════════════════════════════════════
// ARM 1 — THE DELIVERY MOMENT REFUSES THE STAMPED ACK, AND ONLY THE STAMPED ACK
// ════════════════════════════════════════════════════════════════════════

describe('ARM 1 — the promoted start line is not evidence that the ask was answered', () => {
  it('RED (the driven S1 shape): the ack lands and the ask is STILL claimed', () => {
    claimedAsk('m-1', 4);
    ackDelivery('d-ack', 'msg-ack', 'On it — reading both files now.');
    const r = settleAsk(askIdForMessage('m-1'), { agentId: AGENT, turnNumber: 4, at: 'delivery' });
    expect(r.verdict).toBe('unchanged');
    expect(workFor('m-1').state).toBe('claimed');
    expect(receiptOf('m-1')).toBeNull();
  });

  it('the REAL answer closes it, once, on its own delivery — and CT0 never has to repair it', () => {
    claimedAsk('m-1', 4);
    ackDelivery('d-ack', 'msg-ack', 'On it — reading both files now.');
    settleAsk(askIdForMessage('m-1'), { agentId: AGENT, turnNumber: 4, at: 'delivery' });
    // +8 s: the answer.
    bubbleDelivery('d-ans', 'msg-ans', 'Done — t2b.txt was longer, by two lines.',
      { turn: 4, offsetSeconds: 8 });
    const close = settleAsk(askIdForMessage('m-1'), { agentId: AGENT, turnNumber: 4, at: 'delivery' });
    expect(close.verdict).toBe('closed');
    expect(receiptOf('m-1')).toBe('d-ans');
    // The boundary now finds nothing to correct: no repoint, no hand-back, no re-serve.
    finalizedTurn(4, 'msg-ans');
    settleAsksAtTurnFinalize({ agentId: AGENT, turnNumber: 4 });
    expect(workFor('m-1').state).toBe('done');
    expect(receiptOf('m-1')).toBe('d-ans');
    expect(markersFor('m-1')).not.toContain('ct0_receipt_repointed');
    expect(markersFor('m-1')).not.toContain('ct0_ask_re_served');
    expect(transitionsFor('m-1').map((t) => t.to)).toEqual(['claimed', 'done']);
  });

  it('CONTROL (TB1 preserved): an UNSTAMPED quick answer still closes AT SEND TIME', () => {
    claimedAsk('m-1', 4);
    bubbleDelivery('d-ans', 'msg-ans', 'Sixteen. store.ts is the biggest.', { turn: 4 });
    const r = settleAsk(askIdForMessage('m-1'), { agentId: AGENT, turnNumber: 4, at: 'delivery' });
    expect(r.verdict).toBe('closed');
    expect(r.deliveryId).toBe('d-ans');
    expect(workFor('m-1').state).toBe('done');
  });
});

// ════════════════════════════════════════════════════════════════════════
// ARM 2 — THE CRASH SHAPE. The stamp is DURABLE, so the boot arms inherit the truth.
// ════════════════════════════════════════════════════════════════════════

describe('ARM 2 — a turn that acked and died hands the ask BACK OPEN', () => {
  it('RED (driven at ba49131: the ask stayed done on the ack): boot re-arms it, cause named', () => {
    claimedAsk('m-1', 4);
    liveTurn(4, 0);                       // killed between the ack and the answer
    ackDelivery('d-ack', 'msg-ack', 'On it — reading both files now.');
    settleAsk(askIdForMessage('m-1'), { agentId: AGENT, turnNumber: 4, at: 'delivery' });
    expect(workFor('m-1').state).toBe('claimed');   // it was never closed on the ack

    const r = reconcileOrphanedClaims();
    expect(r.reArmed).toBe(1);
    expect(workFor('m-1').state).toBe('open');
    expect(receiptOf('m-1')).toBeNull();
    const last = transitionsFor('m-1').at(-1)!;
    expect(last.to).toBe('open');
    expect(last.reason).toContain('boot reconciliation');
    expect(last.reason.length).toBeGreaterThan(40);      // a NAMED cause, not a shrug
  });

  it('CONTROL (P6b preserved): a killed turn that DID effectful work is HELD, never re-fired', () => {
    claimedAsk('m-1', 4);
    liveTurn(4, 2);
    ackDelivery('d-ack', 'msg-ack', 'On it — sending those now.');
    settleAsk(askIdForMessage('m-1'), { agentId: AGENT, turnNumber: 4, at: 'delivery' });
    const r = reconcileOrphanedClaims();
    expect(r.reArmed).toBe(0);
    expect(r.held).toBe(1);
    expect(workFor('m-1').state).toBe('claimed');
  });
});

// ════════════════════════════════════════════════════════════════════════
// ARM 3 — CT0's BOUNDARY ARM IS UNTOUCHED. It is the backstop for shapes the stamp cannot see.
// ════════════════════════════════════════════════════════════════════════

describe('ARM 3 — the sixth narrowing behaves byte-identically on unstamped rows', () => {
  it('an UNSTAMPED opening line still closes mid-turn and the BOUNDARY still re-points it', () => {
    claimedAsk('m-1', 4);
    bubbleDelivery('d-ack', 'msg-ack', 'On it — checking the folder now.', { turn: 4 });
    expect(settleAsk(askIdForMessage('m-1'), { agentId: AGENT, turnNumber: 4, at: 'delivery' }).verdict)
      .toBe('closed');
    expect(receiptOf('m-1')).toBe('d-ack');
    bubbleDelivery('d-ans', 'msg-ans', '16 .ts files. The largest is store.ts.',
      { turn: 4, offsetSeconds: 7 });
    finalizedTurn(4, 'msg-ans');
    settleAsksAtTurnFinalize({ agentId: AGENT, turnNumber: 4 });
    expect(workFor('m-1').state).toBe('done');
    expect(receiptOf('m-1')).toBe('d-ans');
    expect(markersFor('m-1')).toContain('ct0_receipt_repointed');
  });

  it('an UNSTAMPED ack-only turn is still handed back at the boundary with its named cause', () => {
    claimedAsk('m-1', 4);
    bubbleDelivery('d-ack', 'msg-ack', 'On it — I will look into that now.', { turn: 4 });
    settleAsk(askIdForMessage('m-1'), { agentId: AGENT, turnNumber: 4, at: 'delivery' });
    finalizedTurn(4, null);
    settleAsksAtTurnFinalize({ agentId: AGENT, turnNumber: 4 });
    expect(workFor('m-1').state).toBe('open');
    expect(transitionsFor('m-1').at(-1)!.reason).toContain('start-ack');
  });

  it('a STAMPED ack-only turn reaches the boundary already owed, and is re-opened there', () => {
    claimedAsk('m-1', 4);
    ackDelivery('d-ack', 'msg-ack', 'On it — I will look into that now.');
    settleAsk(askIdForMessage('m-1'), { agentId: AGENT, turnNumber: 4, at: 'delivery' });
    expect(workFor('m-1').state).toBe('claimed');
    finalizedTurn(4, null);
    settleAsksAtTurnFinalize({ agentId: AGENT, turnNumber: 4 });
    // The structural invariant: no ask remains `claimed` by a finalized turn.
    expect(workFor('m-1').state).toBe('open');
    expect(transitionsFor('m-1').map((t) => t.to)).toEqual(['claimed', 'open']);
  });
});

// ════════════════════════════════════════════════════════════════════════
// ARM 4 — THE NARROWING NAMES ONE VALUE, NOT THE COLUMN
// ════════════════════════════════════════════════════════════════════════

describe('ARM 4 — the seventh narrowing, alone, read through the authority own predicate', () => {
  it('refuses a delivery whose message carries origin_intent=engine_start_ack', () => {
    claimedAsk('m-1', 4);
    ackDelivery('d-ack', 'msg-ack', 'On it — starting now.');
    expect(askAnswerEvidence(askIdForMessage('m-1'), 4)).toBeNull();
  });

  it('passes the identical delivery with the stamp absent', () => {
    claimedAsk('m-1', 4);
    bubbleDelivery('d-ack', 'msg-ack', 'On it — starting now.', { turn: 4 });
    expect(askAnswerEvidence(askIdForMessage('m-1'), 4)?.id).toBe('d-ack');
  });

  it('passes a delivery carrying a DIFFERENT origin_intent — the column is not the rule', () => {
    claimedAsk('m-1', 4);
    bubbleDelivery('d-other', 'msg-other', 'Renaming that task.',
      { turn: 4, originIntent: 'pm_rename' });
    expect(askAnswerEvidence(askIdForMessage('m-1'), 4)?.id).toBe('d-other');
  });

  it('CONTROL: a channel send carries no message row, so the stamp rule cannot reach it', () => {
    claimedAsk('m-1', 4);
    mockDb.current!.prepare(
      `INSERT INTO deliveries (id, agent_id, turn_number, tool, channel, conversation_id, outcome, created_at)
       VALUES ('d-email', ?, 4, 'send_email', 'email', ?, 'delivered', datetime('now'))`,
    ).run(AGENT, CONV);
    expect(askAnswerEvidence(askIdForMessage('m-1'), 4)?.id).toBe('d-email');
  });
});
