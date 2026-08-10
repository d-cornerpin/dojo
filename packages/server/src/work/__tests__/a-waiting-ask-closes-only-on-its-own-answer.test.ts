// ════════════════════════════════════════════════════════════════════════════════
// UX-REPAIR ROUND 6 T25 — A WAITING ASK CLOSES ONLY ON A DELIVERY THAT ANSWERS IT.
//
// THE LEDGER, read at HEAD by this worker's own queries (agent 57b52025, 2026-08-10):
//
//   seq 60568  23:00:35  "Compare the three best e-ink tablets under $400…"   → turn 4655
//   seq 60569  23:00:43  "quick one — what's 15% of $240?"        arrived 8 s INTO turn 4655
//   seq 60575  23:01:15  the RESEARCH bubble — no math in it              (delivery 6a20d864)
//   seq 60576  23:01:15  origin_intent='owed_interrupt', turn 4655, quoting the math ask
//              23:01:18  ask 60569 closes open→done on delivery 6a20d864
//   seq 60584  23:03:25  turn 4656 finally answers the math
//
//   SELECT answer_message_id, served_by_turn FROM messages WHERE seq IN (60568, 60569);
//     both → answer 60575, served_by_turn 4655.
//
// Two engine mechanisms, opposite verdicts, three seconds apart. The owed-interrupt path KNEW
// the second ask was owed its own answer — it wrote the row and composed the steer — while
// settlement closed that same ask on the first ask's delivery. Had turn 4656 died, the board
// would have said `done` on an ask whose answer never existed.
//
// THE DISCRIMINATOR IS THE MECHANISM'S OWN RECORD, never text and never arrival timing. The
// owed-interrupt row today names its subject only by QUOTED PROSE, which is unusable as
// evidence — so the fix is at that cause: the path records the ask IDS it owed, on the asks'
// own ledger (`work_events.kind='owed_interrupt'`), with the delivery rowid high-water at the
// instant it fired. A delivery at or below that water is, by the engine's own record, a
// delivery that existed BEFORE anyone was told this ask was still owed.
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
    getDbPath: () => path.join(os.tmpdir(), 'dojo-t25-owed-ask', 'dojo.db'),
  };
});

import { runMigrations } from '../../db/migrations.js';
import { askIdForMessage, claimAsk, stampClaimingTurn } from '../store.js';
import { settleAsk, settleAsksAtTurnFinalize, recordOwedInterruptSubjects } from '../ask-settlement.js';
import { insertMessage } from '../../memory/message-store.js';

const AGENT = 'kevin';
const CONV = 'conv-1';
const TURN = 40;      // the working turn (the ledger's 4655)
const FOLLOW = 41;    // the follow-up turn (the ledger's 4656)

const db = (): Database.Database => mockDb.current!;
const workFor = (messageId: string): Record<string, unknown> =>
  db().prepare('SELECT * FROM work WHERE id = ?').get(askIdForMessage(messageId)) as Record<string, unknown>;
const receiptOf = (messageId: string): string | null => workFor(messageId).result_delivery_id as string | null;

const ownerInbound = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  agentId: AGENT, role: 'user', content: 'compare the three best e-ink tablets under $400',
  lane: 'owner', channel: 'dashboard', senderId: 'owner', authorized: true,
  conversationId: CONV,
  inboundMeta: JSON.stringify({ channel: 'dashboard', relation: 'owner' }),
  ...over,
});

/** An ask picked up by a turn. */
function claimedAsk(messageId: string, turn: number, content?: string): string {
  insertMessage(ownerInbound({ id: messageId, ...(content ? { content } : {}) }) as never);
  claimAsk(askIdForMessage(messageId), AGENT);
  stampClaimingTurn(askIdForMessage(messageId), turn);
  return askIdForMessage(messageId);
}

/** A user-visible assistant bubble and the delivery that carried it. */
function bubbleDelivery(
  deliveryId: string, messageId: string, text: string,
  o: { turn?: number; offsetSeconds?: number } = {},
): void {
  const t = { turn: TURN, offsetSeconds: 0, ...o };
  db().prepare(
    `INSERT INTO messages (id, agent_id, role, content, lane, display_kind, display_tier,
                           conversation_id, turn_number, created_at)
     VALUES (?, ?, 'assistant', ?, 'owner', 'agent-text', 'user-visible', ?, ?, ?)`,
  ).run(messageId, AGENT, text, CONV, t.turn, Date.now() + t.offsetSeconds * 1000);
  db().prepare(
    `INSERT INTO deliveries (id, agent_id, turn_number, tool, channel, conversation_id,
                             message_id, outcome, created_at)
     VALUES (?, ?, ?, 'dashboard', 'dashboard', ?, ?, 'delivered', datetime('now', ?))`,
  ).run(deliveryId, AGENT, t.turn, CONV, messageId, `${t.offsetSeconds} seconds`);
}

function finalizedTurn(n: number, answerMessageId: string | null): void {
  db().prepare(
    `INSERT OR REPLACE INTO turns (agent_id, turn_number, started_at, ended_at, exit_reason,
                                   answered, answer_message_id)
     VALUES (?, ?, datetime('now','-60 seconds'), datetime('now'), ?, ?, ?)`,
  ).run(AGENT, n, answerMessageId ? 'answered' : 'no_reply_intended', answerMessageId ? 1 : 0, answerMessageId);
}

beforeEach(() => {
  const d = new Database(':memory:');
  d.pragma('foreign_keys = ON');
  mockDb.current = d;
  runMigrations();
  d.pragma('foreign_keys = ON');
  d.prepare(`INSERT INTO agents (id, name, status, session_started_at) VALUES (?, 'Kevin', 'idle', '1970-01-01')`).run(AGENT);
  d.prepare(`INSERT INTO conversations (id, agent_id, channel, counterparty_id) VALUES ('conv-1', ?, 'dashboard', 'owner')`).run(AGENT);
});

// ════════════════════════════════════════════════════════════════════
// ARM 1 — THE INCIDENT SHAPE
// ════════════════════════════════════════════════════════════════════

describe('ARM 1 — an ask the engine recorded as OWED is not closed by the delivery it was owed past', () => {
  function theIncident(): void {
    claimedAsk('m-a', TURN, 'Compare the three best e-ink tablets under $400');
    claimedAsk('m-b', TURN, "quick one — what's 15% of $240?");
    // The research bubble: A's answer, no math in it.
    bubbleDelivery('d-research', 'msg-research', "Here's the under-$400 field for handwritten note-taking…");
    // The engine's own record, written the same second the bubble landed.
    recordOwedInterruptSubjects(AGENT, ['m-b'], TURN);
  }

  it('RED: ask B does not close on ask A\'s delivery at A\'s finalize', () => {
    theIncident();
    finalizedTurn(TURN, 'msg-research');
    settleAsksAtTurnFinalize({ agentId: AGENT, turnNumber: TURN });

    expect(workFor('m-a').state).toBe('done');
    expect(receiptOf('m-a')).toBe('d-research');
    // B is still owed and VISIBLE — never done on a receipt that does not answer it.
    expect(workFor('m-b').state).not.toBe('done');
    expect(receiptOf('m-b')).toBeNull();
  });

  it('B closes at ITS answer, with ITS delivery id, on the follow-up turn', () => {
    theIncident();
    finalizedTurn(TURN, 'msg-research');
    settleAsksAtTurnFinalize({ agentId: AGENT, turnNumber: TURN });

    claimAsk(askIdForMessage('m-b'), AGENT);
    stampClaimingTurn(askIdForMessage('m-b'), FOLLOW);
    bubbleDelivery('d-math', 'msg-math', '15% of $240 is $36.', { turn: FOLLOW, offsetSeconds: 130 });
    const close = settleAsk(askIdForMessage('m-b'), { agentId: AGENT, turnNumber: FOLLOW, at: 'delivery' });

    expect(close.verdict).toBe('closed');
    expect(workFor('m-b').state).toBe('done');
    expect(receiptOf('m-b')).toBe('d-math');
  });

  it('CRASH ARM: the follow-up turn never answers — B stays visibly owed, never done', () => {
    theIncident();
    finalizedTurn(TURN, 'msg-research');
    settleAsksAtTurnFinalize({ agentId: AGENT, turnNumber: TURN });

    claimAsk(askIdForMessage('m-b'), AGENT);
    stampClaimingTurn(askIdForMessage('m-b'), FOLLOW);
    finalizedTurn(FOLLOW, null);
    settleAsksAtTurnFinalize({ agentId: AGENT, turnNumber: FOLLOW });

    expect(workFor('m-b').state).toBe('open');
    expect(receiptOf('m-b')).toBeNull();
  });

  it('the model DOES answer it in the same turn, after the re-prompt: that delivery closes it', () => {
    theIncident();
    // The extra round the owed-interrupt bought: a NEW delivery, after the record.
    bubbleDelivery('d-math-same-turn', 'msg-math-same', '15% of $240 is $36.', { offsetSeconds: 12 });
    const close = settleAsk(askIdForMessage('m-b'), { agentId: AGENT, turnNumber: TURN, at: 'delivery' });

    expect(close.verdict).toBe('closed');
    expect(receiptOf('m-b')).toBe('d-math-same-turn');
  });
});

// ════════════════════════════════════════════════════════════════════
// ARM 2 — WHAT IT DOES NOT WIDEN
// ════════════════════════════════════════════════════════════════════

describe('ARM 2 — the narrowing names the RECORD, not arrival timing and not the column', () => {
  it('a single-ask turn is byte-identical: it closes on its delivery at send time', () => {
    claimedAsk('m-1', TURN);
    bubbleDelivery('d-1', 'msg-1', 'Done — here it is.');
    const r = settleAsk(askIdForMessage('m-1'), { agentId: AGENT, turnNumber: TURN, at: 'delivery' });
    expect(r.verdict).toBe('closed');
    expect(receiptOf('m-1')).toBe('d-1');
  });

  it('a mid-turn ask with NO owed-interrupt record closes exactly as today', () => {
    claimedAsk('m-a', TURN);
    claimedAsk('m-b', TURN, 'and the weather?');
    bubbleDelivery('d-1', 'msg-1', 'Both answered here.');
    const r = settleAsk(askIdForMessage('m-b'), { agentId: AGENT, turnNumber: TURN, at: 'delivery' });
    expect(r.verdict).toBe('closed');
    expect(receiptOf('m-b')).toBe('d-1');
  });

  it('a record from a DIFFERENT turn does not narrow this turn\'s evidence', () => {
    claimedAsk('m-b', TURN);
    recordOwedInterruptSubjects(AGENT, ['m-b'], 7);   // some other turn
    bubbleDelivery('d-1', 'msg-1', 'Here you go.');
    const r = settleAsk(askIdForMessage('m-b'), { agentId: AGENT, turnNumber: TURN, at: 'delivery' });
    expect(r.verdict).toBe('closed');
  });
});

// ════════════════════════════════════════════════════════════════════
// ARM 3 — THE RECORD ITSELF
// ════════════════════════════════════════════════════════════════════

describe('ARM 3 — the owed-interrupt path records ask IDS, not quoted prose', () => {
  it('writes one owed_interrupt event per owed ask, carrying the turn and the delivery water', () => {
    claimedAsk('m-b', TURN);
    bubbleDelivery('d-research', 'msg-research', 'the research answer');
    recordOwedInterruptSubjects(AGENT, ['m-b'], TURN);

    const rows = db().prepare(
      `SELECT payload FROM work_events WHERE work_id = ? AND kind = 'owed_interrupt'`,
    ).all(askIdForMessage('m-b')) as Array<{ payload: string }>;
    expect(rows).toHaveLength(1);
    const p = JSON.parse(rows[0].payload) as { turnNumber: number; deliveryHighWater: number };
    expect(p.turnNumber).toBe(TURN);
    expect(p.deliveryHighWater).toBeGreaterThan(0);
  });

  it('an owed message with no ask row is skipped, silently and without throwing', () => {
    expect(() => recordOwedInterruptSubjects(AGENT, ['no-such-message'], TURN)).not.toThrow();
    const rows = db().prepare(`SELECT COUNT(*) AS n FROM work_events WHERE kind = 'owed_interrupt'`).get() as { n: number };
    expect(rows.n).toBe(0);
  });
});
