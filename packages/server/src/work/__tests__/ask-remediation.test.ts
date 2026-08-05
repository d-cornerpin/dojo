// SWEEP-A TB3 — THE REMEDIATION PASS, BRANCH BY BRANCH.
//
// The pass corrects the ask ledger's EXISTING bad records. It owns no rule of its own: every
// settlement decision it makes is `settleAsk`'s, and every evidence read is the authority's
// own exported predicate (`askAnswerEvidence`). A parallel remediation rule would be a second
// decider, which is the disease this arc exists to cure — so the clauses below assert the
// pass's DISPOSITIONS, and each one is paired with a negative control differing in exactly
// one detail.
//
// THE GOVERNING PRIORITY (owner ruling, 2026-08-05) settles every tie-break: "the user asks
// the agent to do something and it does it. Period." Ambiguous evidence errs toward SERVING
// THE ASK AGAIN — never toward silence, a parked ticket or a quiet close.
//
// WHAT WAS MEASURED ON THE REAL BODY BEFORE THIS FILE EXISTED (TB3 Step 1, dojo `bfb5473`),
// so each branch below is a shape that really exists rather than one that might:
//   * stuck-`claimed` owner asks           46  (38 with evidence, 8 without)
//   * answered-then-`abandoned`             0  by the authority's predicate (5 by the
//                                             `answer_message_id` stamp — the rule DESIGN
//                                             §5 records as known-insufficient)
//   * `compile_pending` orphans            73
//   * `done` asks whose receipt is a chip  884 (812 with a real same-turn answer to point
//                                             at, 60 ambiguous, 12 never answered at all)

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
    getDbPath: () => path.join(os.tmpdir(), 'dojo-ask-remediation-test', 'dojo.db'),
  };
});

import { runMigrations } from '../../db/migrations.js';
import {
  askIdForMessage, claimAsk, stampClaimingTurn, openDelegationJoin, landPiece, transition,
} from '../store.js';
import { remediateAskLedger, REMEDIATION_ACTOR } from '../ask-remediation.js';
import { insertMessage } from '../../memory/message-store.js';

const AGENT = 'kevin';
const CONV = 'conv-1';

const db = (): Database.Database => mockDb.current!;
const workFor = (messageId: string): Record<string, unknown> =>
  db().prepare('SELECT * FROM work WHERE id = ?').get(askIdForMessage(messageId)) as Record<string, unknown>;
const eventsFor = (messageId: string): Array<{ kind: string; actor: string; payload: string | null }> =>
  db().prepare('SELECT kind, actor, payload FROM work_events WHERE work_id = ? ORDER BY id')
    .all(askIdForMessage(messageId)) as Array<{ kind: string; actor: string; payload: string | null }>;
const transitionsFor = (messageId: string): string[] =>
  eventsFor(messageId).filter((e) => e.kind === 'transition')
    .map((e) => (JSON.parse(e.payload!) as { to: string }).to);

const ownerInbound = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  agentId: AGENT, role: 'user', content: 'can you check the roof quote?',
  lane: 'owner', channel: 'dashboard', senderId: 'owner', authorized: true,
  conversationId: CONV,
  inboundMeta: JSON.stringify({ channel: 'dashboard', relation: 'owner' }),
  ...over,
});

/** A delivery row on the ledger. `displayKind` decides whether it is an ANSWER or a chip:
 *  the fifth narrowing (TB2) keys on the delivery's own message row. */
function seedDelivery(
  id: string,
  o: {
    turn?: number | null; tool?: string; conversationId?: string | null; outcome?: string;
    offsetSeconds?: number; displayKind?: string | null;
  } = {},
): string {
  const p = {
    turn: 4 as number | null, tool: 'dashboard', conversationId: CONV as string | null,
    outcome: 'delivered', offsetSeconds: 0, displayKind: null as string | null, ...o,
  };
  let messageId: string | null = null;
  if (p.displayKind !== null) {
    messageId = `msg-for-${id}`;
    db().prepare(
      `INSERT INTO messages (id, agent_id, role, content, lane, display_kind, created_at, seq)
       VALUES (?, ?, 'assistant', 'x', 'owner', ?, ?, (SELECT COALESCE(MAX(seq),0)+1 FROM messages))`,
    ).run(messageId, AGENT, p.displayKind, Date.now());
  }
  db().prepare(
    `INSERT INTO deliveries (id, agent_id, turn_number, tool, channel, conversation_id, message_id, outcome, created_at)
     VALUES (?, ?, ?, ?, 'dashboard', ?, ?, ?, datetime('now', ?))`,
  ).run(id, AGENT, p.turn, p.tool, p.conversationId, messageId, p.outcome, `${p.offsetSeconds} seconds`);
  return id;
}

/** A turn row. `ended` decides whether the turn is FINALIZED — the pass must never touch an
 *  ask whose claiming turn is still live. */
function seedTurn(turn: number, ended = true): void {
  db().prepare(
    `INSERT OR REPLACE INTO turns (agent_id, turn_number, started_at, ended_at, exit_reason, answered)
     VALUES (?, ?, datetime('now', '-60 seconds'), ${ended ? "datetime('now', '-30 seconds')" : 'NULL'},
             ${ended ? "'answered'" : 'NULL'}, ?)`,
  ).run(AGENT, turn, ended ? 1 : 0);
}

/** An ask stranded `claimed` by a turn that finalized — the fossil class itself. */
function stuckClaimedAsk(messageId: string, turn: number, over: Record<string, unknown> = {}): string {
  insertMessage(ownerInbound({ id: messageId, ...over }) as never);
  const id = askIdForMessage(messageId);
  claimAsk(id, AGENT);
  stampClaimingTurn(id, turn);
  seedTurn(turn, true);
  return id;
}

/** An ask closed on a delivery — used to build the chip-receipt and orphan shapes. */
function closedAsk(messageId: string, turn: number, deliveryId: string, over: Record<string, unknown> = {}): string {
  insertMessage(ownerInbound({ id: messageId, ...over }) as never);
  const id = askIdForMessage(messageId);
  claimAsk(id, AGENT);
  stampClaimingTurn(id, turn);
  seedTurn(turn, true);
  const r = transition(id, {
    to: 'done', by: 'agent', actorId: AGENT, resultDeliveryId: deliveryId,
    reason: 'delivered via dashboard',
  });
  expect(r.kind).toBe('applied');
  return id;
}

beforeEach(() => {
  const d = new Database(':memory:');
  d.pragma('foreign_keys = ON');
  mockDb.current = d;
  runMigrations();
  d.pragma('foreign_keys = ON');
  d.prepare(
    `INSERT INTO agents (id, name, status, session_started_at) VALUES (?, 'Kevin', 'idle', '1970-01-01')`,
  ).run(AGENT);
  d.prepare(
    `INSERT INTO conversations (id, agent_id, channel, counterparty_id)
     VALUES ('conv-1', ?, 'dashboard', 'owner'), ('conv-2', ?, 'imessage', '+15550000')`,
  ).run(AGENT, AGENT);
});

// ════════════════════════════════════════════════════════════════════════
// CLASS 1 — STUCK `claimed`: the evidence split, and it is the AUTHORITY's
// ════════════════════════════════════════════════════════════════════════

describe('CLASS 1 — a stuck `claimed` ask is adjudicated by the authority, never by the pass', () => {
  it('WITH evidence: closes `done` pointing at the delivery that really answered it', () => {
    stuckClaimedAsk('m-1', 4);
    seedDelivery('d-1', { turn: 4 });
    const r = remediateAskLedger();
    expect(r.stuckClaimed.candidates).toBe(1);
    expect(r.stuckClaimed.closed).toBe(1);
    const w = workFor('m-1');
    expect(w.state).toBe('done');
    expect(w.result_delivery_id).toBe('d-1');
  });

  it('NEGATIVE CONTROL, one detail different — the only delivery is a tool-call CHIP: re-opened, never closed', () => {
    stuckClaimedAsk('m-1', 4);
    seedDelivery('d-1', { turn: 4, displayKind: 'tool-turn' });
    const r = remediateAskLedger();
    expect(r.stuckClaimed.reopened).toBe(1);
    expect(r.stuckClaimed.closed).toBe(0);
    expect(workFor('m-1').state).toBe('open');
  });

  it('WITHOUT evidence: handed back `open` — visible again, never parked and never closed', () => {
    stuckClaimedAsk('m-1', 4);
    const r = remediateAskLedger();
    expect(r.stuckClaimed.reopened).toBe(1);
    expect(workFor('m-1').state).toBe('open');
    expect(transitionsFor('m-1')).toEqual(['claimed', 'open']);
  });

  it('a LIVE claiming turn is never touched — the pass adjudicates fossils, not work in flight', () => {
    insertMessage(ownerInbound({ id: 'm-1' }) as never);
    const id = askIdForMessage('m-1');
    claimAsk(id, AGENT);
    stampClaimingTurn(id, 9);
    seedTurn(9, false);                       // the turn has NOT finalized
    const r = remediateAskLedger();
    expect(r.stuckClaimed.candidates).toBe(0);
    expect(workFor('m-1').state).toBe('claimed');
  });

  it('an unresolved delegation HOLDS rather than closes or re-opens (the authority arm, unchanged)', () => {
    const id = stuckClaimedAsk('m-1', 4);
    seedDelivery('d-1', { turn: 4 });
    openDelegationJoin({
      parentWorkId: id, agentId: AGENT, replyConversationId: CONV, ttlAt: Date.now() + 600_000,
      threads: [{ threadId: 'thread-1', assigneeAgent: 'peer', title: 'piece' }],
    });
    const r = remediateAskLedger();
    expect(r.stuckClaimed.held).toBe(1);
    expect(workFor('m-1').state).toBe('blocked');
  });
});

// ════════════════════════════════════════════════════════════════════════
// CLASS 2 — ANSWERED-THEN-`abandoned`: corrected only where the ledger says so
// ════════════════════════════════════════════════════════════════════════

describe('CLASS 2 — an answered ask written off as `abandoned` is corrected, with the write-off kept', () => {
  it('WITH evidence: `abandoned` -> `open` -> `done`-with-receipt, and the write-off stays in the history', () => {
    stuckClaimedAsk('m-1', 4);
    seedDelivery('d-1', { turn: 4 });
    transition(askIdForMessage('m-1'), {
      to: 'abandoned', by: 'agent', actorId: AGENT, reason: 'unservable — no conversation identity',
    });
    const r = remediateAskLedger();
    expect(r.answeredThenAbandoned.corrected).toBe(1);
    const w = workFor('m-1');
    expect(w.state).toBe('done');
    expect(w.result_delivery_id).toBe('d-1');
    // The record is never falsified: every move is still there, in order.
    expect(transitionsFor('m-1')).toEqual(['claimed', 'abandoned', 'open', 'done']);
    expect(eventsFor('m-1').some((e) => e.actor === REMEDIATION_ACTOR)).toBe(true);
  });

  it('NEGATIVE CONTROL, one detail different — no delivery ever recorded: the write-off is LEFT ALONE', () => {
    stuckClaimedAsk('m-1', 4);
    transition(askIdForMessage('m-1'), {
      to: 'abandoned', by: 'agent', actorId: AGENT, reason: 'unservable — no conversation identity',
    });
    const r = remediateAskLedger();
    expect(r.answeredThenAbandoned.corrected).toBe(0);
    expect(workFor('m-1').state).toBe('abandoned');
    expect(transitionsFor('m-1')).toEqual(['claimed', 'abandoned']);
  });
});

// ════════════════════════════════════════════════════════════════════════
// CLASS 3 — `compile_pending` ORPHANS: the flag is cleared, the backlog is not stormed
// ════════════════════════════════════════════════════════════════════════

describe('CLASS 3 — a `done` ask still flagged compile-pending has its flag cleared, with a dated event', () => {
  it('the flag goes to 0 and `compile_resolved` records why', () => {
    const id = closedAsk('m-1', 4, seedDelivery('d-1', { turn: 4 }));
    db().prepare('UPDATE work SET compile_pending = 1, remaining_children = 0 WHERE id = ?').run(id);
    const r = remediateAskLedger();
    expect(r.compilePendingOrphans.candidates).toBe(1);
    expect(r.compilePendingOrphans.cleared).toBe(1);
    expect(workFor('m-1').compile_pending).toBe(0);
    expect(eventsFor('m-1').some((e) => e.kind === 'compile_resolved')).toBe(true);
  });

  it('the row STAYS `done` and keeps its own receipt — the pass never re-points an ancient join', () => {
    const id = closedAsk('m-1', 4, seedDelivery('d-1', { turn: 4 }));
    db().prepare('UPDATE work SET compile_pending = 1, remaining_children = 0 WHERE id = ?').run(id);
    remediateAskLedger();
    const w = workFor('m-1');
    expect(w.state).toBe('done');
    expect(w.result_delivery_id).toBe('d-1');
  });

  it('NEGATIVE CONTROL, one detail different — a child is still OUT: the flag is left alone', () => {
    const id = closedAsk('m-1', 4, seedDelivery('d-1', { turn: 4 }));
    db().prepare('UPDATE work SET compile_pending = 1, remaining_children = 2 WHERE id = ?').run(id);
    const r = remediateAskLedger();
    expect(r.compilePendingOrphans.candidates).toBe(0);
    expect(workFor('m-1').compile_pending).toBe(1);
  });
});

// ════════════════════════════════════════════════════════════════════════
// CLASS 4/5 — A RECEIPT THAT IS A TOOL-CALL CHIP
// ════════════════════════════════════════════════════════════════════════

describe('CLASS 4 — a closed ask whose receipt is a chip is re-pointed at the answer that really went out', () => {
  it('the same turn ALSO delivered prose: the receipt moves to the prose delivery, with a dated event', () => {
    const chip = seedDelivery('d-chip', { turn: 4, displayKind: 'tool-turn', offsetSeconds: 0 });
    closedAsk('m-1', 4, chip);
    seedDelivery('d-real', { turn: 4, offsetSeconds: 2 });
    const r = remediateAskLedger();
    expect(r.chipReceipts.repointed).toBe(1);
    expect(workFor('m-1').result_delivery_id).toBe('d-real');
    expect(workFor('m-1').state).toBe('done');
    const audit = eventsFor('m-1').filter((e) => e.kind === 'audit' && e.actor === REMEDIATION_ACTOR);
    expect(audit.length).toBeGreaterThan(0);
    expect(audit.some((e) => e.payload!.includes('d-chip') && e.payload!.includes('d-real'))).toBe(true);
  });

  it('NEGATIVE CONTROL, one detail different — the prose landed on a LATER turn: NOT re-pointed, handed up', () => {
    const chip = seedDelivery('d-chip', { turn: 4, displayKind: 'tool-turn', offsetSeconds: 0 });
    closedAsk('m-1', 4, chip);
    seedDelivery('d-real', { turn: 9, offsetSeconds: 2 });
    const r = remediateAskLedger();
    expect(r.chipReceipts.repointed).toBe(0);
    expect(r.chipReceipts.handedUp).toBe(1);
    expect(workFor('m-1').result_delivery_id).toBe('d-chip');
  });

  it('CLASS 5 — no real answer ever went out: the ask is handed back OPEN, never left closed on a chip', () => {
    const chip = seedDelivery('d-chip', { turn: 4, displayKind: 'tool-turn', offsetSeconds: 0 });
    closedAsk('m-1', 4, chip);
    const r = remediateAskLedger();
    expect(r.chipReceipts.reopened).toBe(1);
    expect(workFor('m-1').state).toBe('open');
    expect(transitionsFor('m-1')).toEqual(['claimed', 'done', 'open']);
  });

  it('a receipt that is NOT a chip is never in this class at all', () => {
    closedAsk('m-1', 4, seedDelivery('d-1', { turn: 4 }));
    const r = remediateAskLedger();
    expect(r.chipReceipts.candidates).toBe(0);
    expect(workFor('m-1').result_delivery_id).toBe('d-1');
  });
});

// ════════════════════════════════════════════════════════════════════════
// THE PASS ITSELF — idempotence, scope, and the edge shapes the real body carries
// ════════════════════════════════════════════════════════════════════════

describe('THE PASS — it runs once, it stays in its lane, and it survives the edge shapes', () => {
  it('IDEMPOTENT: a second run finds nothing left and writes nothing', () => {
    stuckClaimedAsk('m-1', 4);
    seedDelivery('d-1', { turn: 4 });
    const first = remediateAskLedger();
    expect(first.stuckClaimed.closed).toBe(1);
    const eventsAfterFirst = eventsFor('m-1').length;
    const second = remediateAskLedger();
    expect(second.stuckClaimed.candidates).toBe(0);
    expect(second.chipReceipts.candidates).toBe(0);
    expect(eventsFor('m-1').length).toBe(eventsAfterFirst);
  });

  it('a NULL conversation_id is carried, not crashed on, and closes nothing', () => {
    insertMessage(ownerInbound({ id: 'm-1' }) as never);
    const id = askIdForMessage('m-1');
    db().prepare('UPDATE work SET conversation_id = NULL WHERE id = ?').run(id);
    claimAsk(id, AGENT);
    stampClaimingTurn(id, 4);
    seedTurn(4, true);
    seedDelivery('d-1', { turn: 4 });
    const r = remediateAskLedger();
    expect(r.stuckClaimed.candidates).toBe(1);
    expect(r.stuckClaimed.closed).toBe(0);
    expect(workFor('m-1').state).toBe('open');
  });

  it('a delivery in ANOTHER conversation is not this ask own answer', () => {
    stuckClaimedAsk('m-1', 4);
    seedDelivery('d-1', { turn: 4, conversationId: 'conv-2' });
    const r = remediateAskLedger();
    expect(r.stuckClaimed.closed).toBe(0);
    expect(workFor('m-1').state).toBe('open');
  });

  it('a SUB-SECOND tie between the ask arrival and the delivery closes it (the ledger own resolution)', () => {
    stuckClaimedAsk('m-1', 4);
    // `deliveries.created_at` carries whole seconds; the ask carries epoch-ms. A delivery
    // recorded inside the SAME second as the ask arrived must still count.
    seedDelivery('d-1', { turn: 4, offsetSeconds: 0 });
    const r = remediateAskLedger();
    expect(r.stuckClaimed.closed).toBe(1);
  });

  it('a non-`ask` work row is never touched by any class', () => {
    stuckClaimedAsk('m-1', 4);
    seedDelivery('d-1', { turn: 4 });
    db().prepare("UPDATE work SET kind = 'commitment' WHERE id = ?").run(askIdForMessage('m-1'));
    const r = remediateAskLedger();
    expect(r.stuckClaimed.candidates).toBe(0);
    expect(workFor('m-1').state).toBe('claimed');
  });

  it('DRY RUN counts every branch and writes nothing', () => {
    stuckClaimedAsk('m-1', 4);
    seedDelivery('d-1', { turn: 4 });
    stuckClaimedAsk('m-2', 5);
    const r = remediateAskLedger({ dryRun: true });
    expect(r.stuckClaimed.candidates).toBe(2);
    expect(r.stuckClaimed.closed).toBe(1);
    expect(r.stuckClaimed.reopened).toBe(1);
    expect(workFor('m-1').state).toBe('claimed');
    expect(workFor('m-2').state).toBe('claimed');
  });

  it('EVERY BRANCH TOUCHES A ROW when all five shapes are present at once (a zero-touched branch is untested)', () => {
    // 1 — stuck claimed, with evidence
    stuckClaimedAsk('m-1', 4); seedDelivery('d-1', { turn: 4 });
    // 2 — stuck claimed, no evidence
    stuckClaimedAsk('m-2', 5);
    // 3 — answered then abandoned
    stuckClaimedAsk('m-3', 6); seedDelivery('d-3', { turn: 6 });
    transition(askIdForMessage('m-3'), { to: 'abandoned', by: 'agent', actorId: AGENT, reason: 'unservable' });
    // 4 — orphan
    const orphan = closedAsk('m-4', 7, seedDelivery('d-4', { turn: 7 }));
    db().prepare('UPDATE work SET compile_pending = 1, remaining_children = 0 WHERE id = ?').run(orphan);
    // 5 — chip with a real same-turn answer
    closedAsk('m-5', 8, seedDelivery('d-5chip', { turn: 8, displayKind: 'tool-turn', offsetSeconds: 0 }));
    seedDelivery('d-5real', { turn: 8, offsetSeconds: 2 });
    // 6 — chip with no answer at all. It lives in its OWN conversation on purpose: "no real
    // answer ever followed" is a fact about a conversation, and the five shapes above are all
    // answering into conv-1, so sharing it would make this row read as ambiguous rather than
    // unanswered — the shapes must not contaminate each other.
    closedAsk(
      'm-6', 10,
      seedDelivery('d-6chip', { turn: 10, displayKind: 'tool-turn', offsetSeconds: 0, conversationId: 'conv-2' }),
      { conversationId: 'conv-2' },
    );

    const r = remediateAskLedger();
    expect(r.stuckClaimed.closed).toBe(1);
    expect(r.stuckClaimed.reopened).toBe(1);
    expect(r.answeredThenAbandoned.corrected).toBe(1);
    expect(r.compilePendingOrphans.cleared).toBe(1);
    expect(r.chipReceipts.repointed).toBe(1);
    expect(r.chipReceipts.reopened).toBe(1);
    // and the invariant the whole pass exists for
    expect(db().prepare("SELECT COUNT(*) AS n FROM work WHERE kind='ask' AND state='claimed'").get())
      .toEqual({ n: 0 });
  });
});

// ════════════════════════════════════════════════════════════════════════
// THE JOIN SHAPE — a delegated ask that really did settle is left alone
// ════════════════════════════════════════════════════════════════════════

describe('THE JOIN SHAPE — a settled delegation is not the orphan class', () => {
  it('a join whose children all landed and whose flag is already 0 is not a candidate', () => {
    const id = stuckClaimedAsk('m-1', 4);
    const children = openDelegationJoin({
      parentWorkId: id, agentId: AGENT, replyConversationId: CONV, ttlAt: Date.now() + 600_000,
      threads: [{ threadId: 'thread-1', assigneeAgent: 'peer', title: 'piece' }],
    });
    landPiece(children[0]!, { deliveryId: seedDelivery('d-piece', { turn: 6 }), content: 'the piece' });
    db().prepare('UPDATE work SET compile_pending = 0 WHERE id = ?').run(id);
    const r = remediateAskLedger();
    expect(r.compilePendingOrphans.candidates).toBe(0);
  });
});
