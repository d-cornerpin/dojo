// SWEEP-A TB2 Step 1 — EVIDENCE-BACKED COMPLETION FOR A DELEGATED JOB, AND THE LADDER.
//
// ── WHAT WAS MEASURED AT `5626055`, so "RED" is a number rather than a claim ──
// The kit scenario `delegation-longhorizon` clause (e) reproduced 2 of 2 (TB0 report §5). The
// premature close was read off the real body at this task's Step 0, and the cause is one row
// deeper than the report's wording:
//
//   attempt 1  ask:3857ef59  done 10:34:39, receipt 3da6365b -> message a03a5ac9
//   attempt 2  ask:b72e81ad  done 10:40:49, receipt 49c963a2 -> message 98ffe54b
//
// BOTH of those message rows are `display_kind='tool-turn'` — the model's own `tool_use`
// blocks, rendered by the dashboard as CHIPS. A tool-call chip is not an answer to anybody,
// and closing an owner's question on one is the same class of error the `engine-ack`
// exclusion already refuses ("a start-ack is not an answer"). In both attempts the GENUINE
// reply (`display_kind='agent-text'`) landed AFTER `join_opened` — 10:41:00 vs 10:40:56 on
// attempt 2 — so with the chip excluded the authority's existing hold arm fires on the real
// reply and the ask never reaches `done` at all. That is why the ordering fix is a NARROWING
// of the evidence and not a re-open: the kit judge reads the `work_events` HISTORY, so a
// `done` that is later undone is still a premature close.
//
// The clauses below are the five the task brief names, each with a negative control:
//   (i)   a tool-turn chip is not an answer; the delegating turn ends NON-TERMINAL (`blocked`)
//         and NO `done` transition exists before the join completed;
//   (ii)  children settled + the compiled delivery -> `done` with THAT receipt, through the
//         authority, with `compile_resolved` written;
//   (iii) a re-drive counter accrues on the row's own events;
//   (iv)  after N=3 failed re-drives the ladder asks for the STUCK NOTICE, bounded;
//   (v)   after the notice's own bound the ladder hands the fault to the platform surface.

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
    getDbPath: () => path.join(os.tmpdir(), 'dojo-join-settlement-test', 'dojo.db'),
  };
});

import { runMigrations } from '../../db/migrations.js';
import {
  askIdForMessage, claimAsk, stampClaimingTurn, openDelegationJoin, landPiece, transition,
  owedSendObligations,
} from '../store.js';
import {
  settleAsk, settleAsksForDelivery, settleAsksAtTurnFinalize, settleAskOnJoin,
} from '../ask-settlement.js';
import {
  JOIN_REDRIVE_BOUND, STUCK_NOTICE_RETRY_BOUND, JOIN_DRIVE_ENTRY,
  joinDriveCount, recordJoinDrive, nextJoinDriveRung,
} from '../join-drive.js';
import { insertMessage } from '../../memory/message-store.js';

const AGENT = 'kevin';
const PEER = 'worker-a';
const CONV = 'conv-1';

const workRow = (id: string): Record<string, unknown> =>
  mockDb.current!.prepare('SELECT * FROM work WHERE id = ?').get(id) as Record<string, unknown>;
const transitionsFor = (workId: string): Array<{ to: string; reason: string }> =>
  (mockDb.current!.prepare(
    `SELECT payload FROM work_events WHERE work_id = ? AND kind = 'transition' ORDER BY id`,
  ).all(workId) as Array<{ payload: string }>)
    .map((r) => JSON.parse(r.payload) as { to: string; reason: string });
const eventKinds = (workId: string): string[] =>
  (mockDb.current!.prepare('SELECT kind FROM work_events WHERE work_id = ? ORDER BY id')
    .all(workId) as Array<{ kind: string }>).map((r) => r.kind);

/** An owner inbound, exactly as the chat route writes one. */
const ownerInbound = (id: string, over: Record<string, unknown> = {}): Record<string, unknown> => ({
  id, agentId: AGENT, role: 'user', content: 'build me one combined report from two pieces',
  lane: 'owner', channel: 'dashboard', senderId: 'owner', authorized: true,
  conversationId: CONV,
  inboundMeta: JSON.stringify({ channel: 'dashboard', relation: 'owner' }),
  ...over,
});

/**
 * A dashboard delivery, WITH the assistant row it carried. `displayKind` is the whole point of
 * clause (i): `tool-turn` is a `tool_use` chip, `agent-text` is the model's prose.
 */
function seedDelivery(
  id: string,
  o: { turn: number; displayKind: 'tool-turn' | 'agent-text'; content?: string; offsetSeconds?: number;
       tool?: string; conversationId?: string | null },
): string {
  const messageId = `msg-${id}`;
  insertMessage({
    id: messageId, agentId: AGENT, role: 'assistant',
    content: o.content ?? (o.displayKind === 'tool-turn'
      ? '[{"type":"tool_use","id":"call_1","name":"work_open","input":{}}]'
      : 'Kicked off both specialists; I will report back.'),
    lane: 'owner', conversationId: o.conversationId === undefined ? CONV : o.conversationId,
    turnNumber: o.turn,
  } as never);
  // The classifier is what normally sets this; the test states it directly so the clause is
  // about the SETTLEMENT rule and not about re-testing the taxonomy.
  mockDb.current!.prepare('UPDATE messages SET display_kind = ? WHERE id = ?')
    .run(o.displayKind, messageId);
  mockDb.current!.prepare(
    `INSERT INTO deliveries (id, agent_id, turn_number, tool, channel, conversation_id, message_id, outcome, created_at)
     VALUES (?, ?, ?, ?, 'dashboard', ?, ?, 'delivered', datetime('now', ?))`,
  ).run(
    id, AGENT, o.turn, o.tool ?? 'dashboard',
    o.conversationId === undefined ? CONV : o.conversationId,
    messageId, `${o.offsetSeconds ?? 0} seconds`,
  );
  return id;
}

/** The owner ask, picked up by a turn — where every delegating turn starts. */
function claimedAsk(messageId: string, turn: number): string {
  insertMessage(ownerInbound(messageId) as never);
  const id = askIdForMessage(messageId);
  claimAsk(id, AGENT);
  stampClaimingTurn(id, turn);
  return id;
}

/** Open the join the delegation-exit step opens, with `n` children. */
function openJoin(askId: string, n = 2): string[] {
  return openDelegationJoin({
    parentWorkId: askId, agentId: AGENT, replyConversationId: CONV,
    ttlAt: Date.now() + 60 * 60_000,
    threads: Array.from({ length: n }, (_, i) => ({
      threadId: `thread-${i}`, assigneeAgent: PEER, intent: 'ASSIGN', hopCount: 0,
    })),
  });
}

/** Land every child with real content — the shape that sets `compile_pending = 1`. */
function landAll(childIds: string[]): void {
  for (const [i, childId] of childIds.entries()) {
    const deliveryId = `piece-d-${i}`;
    mockDb.current!.prepare(
      `INSERT INTO deliveries (id, agent_id, turn_number, tool, channel, outcome, created_at)
       VALUES (?, ?, NULL, 'send_to_agent', 'a2a', 'delivered', datetime('now'))`,
    ).run(deliveryId, AGENT);
    landPiece(childId, { deliveryId, content: `HARBOR-${i}`, messageId: null, actorId: PEER });
  }
}

beforeEach(() => {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  mockDb.current = db;
  runMigrations();
  db.pragma('foreign_keys = ON');
  db.prepare(
    `INSERT INTO agents (id, name, status, session_started_at) VALUES (?, 'Kevin', 'idle', '1970-01-01'), (?, 'Worker A', 'idle', '1970-01-01')`,
  ).run(AGENT, PEER);
  db.prepare(
    `INSERT INTO conversations (id, agent_id, channel, counterparty_id) VALUES (?, ?, 'dashboard', 'owner')`,
  ).run(CONV, AGENT);
});

// ════════════════════════════════════════════════════════════════════════
// (i) THE ORDERING — a tool-call chip is not an answer, so the delegating
//     turn ends with the ask NON-TERMINAL and never writes a `done` at all.
// ════════════════════════════════════════════════════════════════════════

describe('(i) a delegating turn ends with the owner ask NON-TERMINAL', () => {
  it('NEGATIVE CONTROL: a `tool-turn` delivery does NOT close the ask', () => {
    const askId = claimedAsk('m-1', 7);
    seedDelivery('d-chip', { turn: 7, displayKind: 'tool-turn' });
    const closed = settleAsksForDelivery({
      agentId: AGENT, turnNumber: 7, deliveryId: 'd-chip', conversationId: CONV,
      tool: 'dashboard', outcome: 'delivered',
    });
    expect(closed).toBe(0);
    expect(workRow(askId).state).toBe('claimed');
  });

  it('POSITIVE CONTROL (the same shape, one detail changed): an `agent-text` delivery DOES close it', () => {
    const askId = claimedAsk('m-1', 7);
    seedDelivery('d-reply', { turn: 7, displayKind: 'agent-text' });
    const closed = settleAsksForDelivery({
      agentId: AGENT, turnNumber: 7, deliveryId: 'd-reply', conversationId: CONV,
      tool: 'dashboard', outcome: 'delivered',
    });
    expect(closed).toBe(1);
    expect(workRow(askId).state).toBe('done');
  });

  it('THE RECORDED SHAPE, END TO END: chip -> join opens -> the real reply lands -> `blocked`, and NO `done` was ever written', () => {
    // This is run bmsfy5txir3 attempt 2's own sequence, with its own ordering:
    // chip delivered, THEN the delegation join opened, THEN the model's prose reply.
    const askId = claimedAsk('m-1', 7);
    seedDelivery('d-chip', { turn: 7, displayKind: 'tool-turn' });
    settleAsksForDelivery({
      agentId: AGENT, turnNumber: 7, deliveryId: 'd-chip', conversationId: CONV,
      tool: 'dashboard', outcome: 'delivered',
    });
    openJoin(askId, 2);
    seedDelivery('d-reply', { turn: 7, displayKind: 'agent-text' });
    settleAsksForDelivery({
      agentId: AGENT, turnNumber: 7, deliveryId: 'd-reply', conversationId: CONV,
      tool: 'dashboard', outcome: 'delivered',
    });

    const row = workRow(askId);
    expect(row.state).toBe('blocked');
    expect(row.remaining_children).toBe(2);
    // The kit judge reads HISTORY: a `done` that is later undone is still a premature close.
    expect(transitionsFor(askId).filter((t) => t.to === 'done')).toHaveLength(0);
    expect(transitionsFor(askId).at(-1)!.reason).toMatch(/delegated work is still outstanding/);
  });
});

describe('(i-b) the OTHER ordering — the turn answered FIRST and delegated after', () => {
  it('the turn boundary hands the closed ask back and HOLDS it (run bmsg2ufve1q, ask:b66cbb75)', () => {
    // MEASURED SHAPE: a genuine prose status line at +19 s closed the ask; the model only
    // issued its `send_to_agent` calls at +40 s. At the close there was no delegated work in
    // existence, so no evidence predicate could have known. At the TURN BOUNDARY there is.
    const askId = claimedAsk('m-1', 7);
    seedDelivery('d-reply', { turn: 7, displayKind: 'agent-text' });
    settleAsksForDelivery({
      agentId: AGENT, turnNumber: 7, deliveryId: 'd-reply', conversationId: CONV,
      tool: 'dashboard', outcome: 'delivered',
    });
    expect(workRow(askId).state).toBe('done');
    openJoin(askId, 2);

    const r = settleAsksAtTurnFinalize({ agentId: AGENT, turnNumber: 7 });
    expect(r.held).toBe(1);
    const row = workRow(askId);
    expect(row.state).toBe('blocked');
    expect(row.remaining_children).toBe(2);
    const path = transitionsFor(askId).map((t) => t.to);
    expect(path).toEqual(['claimed', 'done', 'open', 'blocked']);
    expect(transitionsFor(askId)[2].reason).toMatch(/closed the ask and THEN delegated/);
  });

  // ── SWEEP-A TB6 (TB5 hand-up HU-1): THE HAND-BACK CLEARS THE RECEIPT IT UNDOES ─────────
  //
  // MEASURED, battery `bmsgh439cdv` attempt 2, `ask:fa74a65f`: the boundary handed the row
  // back correctly (`done -> open -> blocked`, 68 ms after the close) but passed only
  // `evidenceRef`, and `store.ts`'s UPDATE preserved `result_delivery_id` on every non-`done`
  // move. The row then sat NON-TERMINAL for 4 m 55 s still pointing at the settlement receipt
  // of the close that had been undone, and the real compiled settlement (`8cb25bbf`) landed
  // 114 s after the test window. The kit's clause (e2) read the superseded pointer and judged
  // the receipt 9.9 s early.
  //
  // The EVENT record is history and stays — undoing it would be the forgery this spine exists
  // to refuse, and the undo's own `evidence_ref` names the receipt it undid, which is asserted
  // below. `result_delivery_id` is not history: it is CURRENT STATE, "the delivery this row is
  // settled on", and an unsettled row is settled on nothing.
  it('a handed-back ask carries NO result_delivery_id, and the undo still names the receipt', () => {
    const askId = claimedAsk('m-1', 7);
    seedDelivery('d-reply', { turn: 7, displayKind: 'agent-text' });
    settleAsksForDelivery({
      agentId: AGENT, turnNumber: 7, deliveryId: 'd-reply', conversationId: CONV,
      tool: 'dashboard', outcome: 'delivered',
    });
    expect(workRow(askId).result_delivery_id, 'premise: the close really did stamp a receipt')
      .toBe('d-reply');
    openJoin(askId, 2);

    settleAsksAtTurnFinalize({ agentId: AGENT, turnNumber: 7 });

    const row = workRow(askId);
    expect(row.state).toBe('blocked');
    expect(row.result_delivery_id, 'a non-terminal row must not point at a settlement receipt')
      .toBeNull();
    // The record is not falsified: the undo transition still carries the receipt it undid.
    const undo = (mockDb.current!.prepare(
      `SELECT payload FROM work_events WHERE work_id = ? AND kind = 'transition' ORDER BY id`,
    ).all(askId) as Array<{ payload: string }>)
      .map((r) => JSON.parse(r.payload) as { to: string; evidence_ref: string | null })
      .find((t) => t.to === 'open');
    expect(undo?.evidence_ref).toBe('d-reply');
  });

  it('and the RE-CLOSE repopulates it — clearing does not make the row uncloseable', () => {
    const askId = claimedAsk('m-1', 7);
    seedDelivery('d-reply', { turn: 7, displayKind: 'agent-text' });
    settleAsksForDelivery({
      agentId: AGENT, turnNumber: 7, deliveryId: 'd-reply', conversationId: CONV,
      tool: 'dashboard', outcome: 'delivered',
    });
    const kids = openJoin(askId, 2);
    settleAsksAtTurnFinalize({ agentId: AGENT, turnNumber: 7 });
    expect(workRow(askId).result_delivery_id).toBeNull();

    landAll(kids);
    seedDelivery('d-compiled', { turn: 9, displayKind: 'agent-text', offsetSeconds: 5, content: 'HARBOR-0 and HARBOR-1' });
    const r = settleAskOnJoin(askId, { agentId: AGENT, reason: 'the compile answered the owner' });

    expect(r.verdict).toBe('closed');
    const row = workRow(askId);
    expect(row.state).toBe('done');
    expect(row.result_delivery_id, 'the row is settled on the COMPILED delivery, not the undone one')
      .toBe('d-compiled');
  });

  it('THE READER THE STALE POINTER WAS SILENCING: the handed-back ask is OWED again', () => {
    // `owedSendObligations` is the claimed-delivery floor's "does this person have an answer
    // outstanding" query. It filters `w.result_delivery_id IS NULL`, and its own comment says
    // that clause is redundant because "`state <> 'done'` already implies it by the DDL's own
    // CHECK". The CHECK says `done` IMPLIES a receipt — not the converse — so a handed-back
    // row carried one, and the floor read the owner as already answered while the ask was
    // still owed. This is the clause that would have caught that, driven both ways.
    const askId = claimedAsk('m-1', 7);
    seedDelivery('d-reply', { turn: 7, displayKind: 'agent-text' });
    settleAsksForDelivery({
      agentId: AGENT, turnNumber: 7, deliveryId: 'd-reply', conversationId: CONV,
      tool: 'dashboard', outcome: 'delivered',
    });
    expect(owedSendObligations(AGENT).map((o) => o.id), 'a genuinely answered ask is not owed')
      .not.toContain(askId);

    openJoin(askId, 2);
    settleAsksAtTurnFinalize({ agentId: AGENT, turnNumber: 7 });

    expect(workRow(askId).state).toBe('blocked');
    expect(owedSendObligations(AGENT).map((o) => o.id), 'handed back means owed again')
      .toContain(askId);
  });

  it('the DDL\'s done-requires-receipt rule is UNTOUCHED — a cleared row cannot close on nothing', () => {
    // The clear must not become a back door into a `done` with no delivery behind it. G7 and
    // `CHECK (state <> 'done' OR result_delivery_id IS NOT NULL)` both still refuse.
    const askId = claimedAsk('m-1', 7);
    seedDelivery('d-reply', { turn: 7, displayKind: 'agent-text' });
    settleAsksForDelivery({
      agentId: AGENT, turnNumber: 7, deliveryId: 'd-reply', conversationId: CONV,
      tool: 'dashboard', outcome: 'delivered',
    });
    openJoin(askId, 2);
    settleAsksAtTurnFinalize({ agentId: AGENT, turnNumber: 7 });
    expect(workRow(askId).result_delivery_id).toBeNull();

    const refused = transition(askId, {
      to: 'done', by: 'agent', actorId: AGENT,
      reason: 'closing it out with nothing to point at',
    });
    expect(refused.kind).toBe('refused');
    expect((refused as { reason: string }).reason).toBe('done-requires-delivery');
    expect(workRow(askId).state).toBe('blocked');
  });

  it('NEGATIVE CONTROL: an ask this turn closed with NO delegation under it is left alone', () => {
    const askId = claimedAsk('m-1', 7);
    seedDelivery('d-reply', { turn: 7, displayKind: 'agent-text' });
    settleAsksForDelivery({
      agentId: AGENT, turnNumber: 7, deliveryId: 'd-reply', conversationId: CONV,
      tool: 'dashboard', outcome: 'delivered',
    });
    const r = settleAsksAtTurnFinalize({ agentId: AGENT, turnNumber: 7 });
    expect(r).toEqual({ closed: 0, held: 0, reopened: 0 });
    expect(workRow(askId).state).toBe('done');
    expect(transitionsFor(askId).map((t) => t.to)).toEqual(['claimed', 'done']);
  });

  it('NEGATIVE CONTROL: another TURN\'s closed-and-delegated ask is not this turn\'s to touch', () => {
    const askId = claimedAsk('m-1', 7);
    seedDelivery('d-reply', { turn: 7, displayKind: 'agent-text' });
    settleAsksForDelivery({
      agentId: AGENT, turnNumber: 7, deliveryId: 'd-reply', conversationId: CONV,
      tool: 'dashboard', outcome: 'delivered',
    });
    openJoin(askId, 2);
    const r = settleAsksAtTurnFinalize({ agentId: AGENT, turnNumber: 9 });
    expect(r).toEqual({ closed: 0, held: 0, reopened: 0 });
    expect(workRow(askId).state).toBe('done');
  });
});

// ════════════════════════════════════════════════════════════════════════
// (ii) THE JOIN ARM OF THE AUTHORITY — the compiled delivery closes it.
// ════════════════════════════════════════════════════════════════════════

describe('(ii) the join settles through the authority, on the COMPILED delivery', () => {
  it('children settled + a delivery that POSTDATES join_complete -> `done` with THAT receipt + `compile_resolved`', () => {
    const askId = claimedAsk('m-1', 7);
    const kids = openJoin(askId, 2);
    seedDelivery('d-reply', { turn: 7, displayKind: 'agent-text' });
    settleAsksForDelivery({
      agentId: AGENT, turnNumber: 7, deliveryId: 'd-reply', conversationId: CONV,
      tool: 'dashboard', outcome: 'delivered',
    });
    expect(workRow(askId).state).toBe('blocked');

    landAll(kids);
    expect(workRow(askId).compile_pending).toBe(1);

    // The compiled answer lands on a LATER turn.
    seedDelivery('d-compiled', { turn: 9, displayKind: 'agent-text', offsetSeconds: 5, content: 'HARBOR-0 and HARBOR-1' });
    const r = settleAskOnJoin(askId, { agentId: AGENT, reason: 'the compile answered the owner' });

    expect(r.verdict).toBe('closed');
    expect(r.deliveryId).toBe('d-compiled');
    const row = workRow(askId);
    expect(row.state).toBe('done');
    expect(row.result_delivery_id).toBe('d-compiled');
    expect(row.compile_pending).toBe(0);
    expect(eventKinds(askId)).toContain('compile_resolved');
  });

  it('NEGATIVE: the EARLIER delivery of the delegating turn is not the compiled answer', () => {
    const askId = claimedAsk('m-1', 7);
    const kids = openJoin(askId, 2);
    seedDelivery('d-status', { turn: 7, displayKind: 'agent-text', offsetSeconds: -30 });
    landAll(kids);
    const r = settleAskOnJoin(askId, { agentId: AGENT, reason: 'x' });
    expect(r.verdict).toBe('unchanged');
    expect(workRow(askId).state).not.toBe('done');
  });

  it('NEGATIVE: "settled" is not widened — a child still outstanding refuses the close outright', () => {
    const askId = claimedAsk('m-1', 7);
    const kids = openJoin(askId, 2);
    landPiece(kids[0], { deliveryId: null as never, content: 'x', messageId: null, actorId: PEER });
    seedDelivery('d-compiled', { turn: 9, displayKind: 'agent-text', offsetSeconds: 5 });
    const r = settleAskOnJoin(askId, { agentId: AGENT, deliveryId: 'd-compiled', reason: 'x' });
    expect(r.verdict).toBe('unchanged');
    expect(r.detail).toMatch(/children/);
    expect(workRow(askId).state).not.toBe('done');
  });

  it('NEGATIVE: the DELEGATING TURN own late status line is not the compiled answer (run bmsg278e0k2)', () => {
    // MEASURED SHAPE, ask:de4b50c5: two toy workers came back ONE SECOND after the status
    // line held the ask, and the same turn's next bubble postdated `join_complete`. Without
    // this narrowing the join arm read "I'll compile the report once they're back" as the
    // report, closed the ask, and the system stopped driving.
    const askId = claimedAsk('m-1', 7);
    const kids = openJoin(askId, 2);
    landAll(kids);
    seedDelivery('d-late-status', { turn: 7, displayKind: 'agent-text', offsetSeconds: 5 });
    const r = settleAskOnJoin(askId, { agentId: AGENT, reason: 'x' });
    expect(r.verdict).toBe('unchanged');
    expect(workRow(askId).state).not.toBe('done');
    expect(workRow(askId).compile_pending).toBe(1);
  });

  it('POSITIVE CONTROL (same shape, one detail changed): the SAME delivery from a LATER turn IS', () => {
    const askId = claimedAsk('m-1', 7);
    const kids = openJoin(askId, 2);
    landAll(kids);
    seedDelivery('d-report', { turn: 8, displayKind: 'agent-text', offsetSeconds: 5 });
    const r = settleAskOnJoin(askId, { agentId: AGENT, reason: 'x' });
    expect(r.verdict).toBe('closed');
    expect(r.deliveryId).toBe('d-report');
  });

  it('POSITIVE: the ENGINE relay records no turn at all, and that qualifies', () => {
    const askId = claimedAsk('m-1', 7);
    const kids = openJoin(askId, 2);
    landAll(kids);
    mockDb.current!.prepare(
      `INSERT INTO deliveries (id, agent_id, turn_number, tool, channel, conversation_id, outcome, created_at)
       VALUES ('d-relay', ?, NULL, 'a2a-join-relay', 'dashboard', ?, 'delivered', datetime('now', '+5 seconds'))`,
    ).run(AGENT, CONV);
    const r = settleAskOnJoin(askId, { agentId: AGENT, deliveryId: 'd-relay', reason: 'engine relay' });
    expect(r.verdict).toBe('closed');
    expect(r.deliveryId).toBe('d-relay');
  });

  it('NEGATIVE: an explicit receipt that is a tool-turn chip is refused as the compiled answer', () => {
    const askId = claimedAsk('m-1', 7);
    const kids = openJoin(askId, 2);
    landAll(kids);
    seedDelivery('d-chip', { turn: 9, displayKind: 'tool-turn', offsetSeconds: 5 });
    const r = settleAskOnJoin(askId, { agentId: AGENT, deliveryId: 'd-chip', reason: 'x' });
    expect(r.verdict).toBe('unchanged');
    expect(workRow(askId).state).not.toBe('done');
  });
});

// ════════════════════════════════════════════════════════════════════════
// (iii)–(v) THE LADDER — OR2's shape: detect, steer, verify, bounded retry,
//           and only then the platform's own surface.
// ════════════════════════════════════════════════════════════════════════

describe('(iii) the re-drive counter accrues on the row own events', () => {
  it('starts at zero and counts one per recorded drive', () => {
    const askId = claimedAsk('m-1', 7);
    openJoin(askId, 2);
    expect(joinDriveCount(askId, JOIN_DRIVE_ENTRY.redrive)).toBe(0);
    recordJoinDrive(askId, JOIN_DRIVE_ENTRY.redrive, { attempt: 1, bound: JOIN_REDRIVE_BOUND });
    recordJoinDrive(askId, JOIN_DRIVE_ENTRY.redrive, { attempt: 2, bound: JOIN_REDRIVE_BOUND });
    expect(joinDriveCount(askId, JOIN_DRIVE_ENTRY.redrive)).toBe(2);
    // …and it is on the ROW's durable event log, not in memory.
    expect(eventKinds(askId)).toContain('audit');
  });

  it('the counter is scoped to its own marker and to its own row', () => {
    const askId = claimedAsk('m-1', 7);
    const other = claimedAsk('m-2', 8);
    recordJoinDrive(askId, JOIN_DRIVE_ENTRY.redrive, { attempt: 1, bound: JOIN_REDRIVE_BOUND });
    recordJoinDrive(askId, JOIN_DRIVE_ENTRY.stuckNotice, { attempt: 1, bound: STUCK_NOTICE_RETRY_BOUND });
    expect(joinDriveCount(askId, JOIN_DRIVE_ENTRY.redrive)).toBe(1);
    expect(joinDriveCount(askId, JOIN_DRIVE_ENTRY.stuckNotice)).toBe(1);
    expect(joinDriveCount(other, JOIN_DRIVE_ENTRY.redrive)).toBe(0);
  });
});

describe('(iv) after N=3 failed re-drives the ladder asks the AGENT to tell the owner', () => {
  it('the first N rungs are REAL DRIVES back to the owed step', () => {
    const askId = claimedAsk('m-1', 7);
    expect(JOIN_REDRIVE_BOUND).toBe(3);
    for (let i = 1; i <= JOIN_REDRIVE_BOUND; i++) {
      const d = nextJoinDriveRung(askId);
      expect(d.rung).toBe('redrive');
      expect(d.attempt).toBe(i);
      expect(d.bound).toBe(JOIN_REDRIVE_BOUND);
      recordJoinDrive(askId, JOIN_DRIVE_ENTRY.redrive, { attempt: d.attempt, bound: d.bound });
    }
  });

  it('the (N+1)th look is the STUCK NOTICE rung, and it is bounded too', () => {
    const askId = claimedAsk('m-1', 7);
    for (let i = 1; i <= JOIN_REDRIVE_BOUND; i++) {
      recordJoinDrive(askId, JOIN_DRIVE_ENTRY.redrive, { attempt: i, bound: JOIN_REDRIVE_BOUND });
    }
    const d = nextJoinDriveRung(askId);
    expect(d.rung).toBe('stuck-notice');
    expect(d.attempt).toBe(1);
    expect(d.bound).toBe(STUCK_NOTICE_RETRY_BOUND);
    expect(d.redrives).toBe(JOIN_REDRIVE_BOUND);
  });
});

describe('(v) the ghost arm — the platform surface only after the notice bound is spent', () => {
  it('the notice retries to its bound, THEN hands the fault to the platform surface', () => {
    const askId = claimedAsk('m-1', 7);
    for (let i = 1; i <= JOIN_REDRIVE_BOUND; i++) {
      recordJoinDrive(askId, JOIN_DRIVE_ENTRY.redrive, { attempt: i, bound: JOIN_REDRIVE_BOUND });
    }
    for (let i = 1; i <= STUCK_NOTICE_RETRY_BOUND; i++) {
      expect(nextJoinDriveRung(askId).rung).toBe('stuck-notice');
      recordJoinDrive(askId, JOIN_DRIVE_ENTRY.stuckNotice, { attempt: i, bound: STUCK_NOTICE_RETRY_BOUND });
    }
    expect(nextJoinDriveRung(askId).rung).toBe('platform-trouble');
  });

  it('the platform rung is reached ONLY at the end — never while a drive or a notice is left', () => {
    const askId = claimedAsk('m-1', 7);
    expect(nextJoinDriveRung(askId).rung).toBe('redrive');
    recordJoinDrive(askId, JOIN_DRIVE_ENTRY.redrive, { attempt: 1, bound: JOIN_REDRIVE_BOUND });
    recordJoinDrive(askId, JOIN_DRIVE_ENTRY.redrive, { attempt: 2, bound: JOIN_REDRIVE_BOUND });
    expect(nextJoinDriveRung(askId).rung).toBe('redrive');
    recordJoinDrive(askId, JOIN_DRIVE_ENTRY.redrive, { attempt: 3, bound: JOIN_REDRIVE_BOUND });
    recordJoinDrive(askId, JOIN_DRIVE_ENTRY.stuckNotice, { attempt: 1, bound: STUCK_NOTICE_RETRY_BOUND });
    expect(nextJoinDriveRung(askId).rung).toBe('stuck-notice');
  });
});

// ════════════════════════════════════════════════════════════════════════
// The hold arm keeps working through the ladder: the ask stays OWED, and it
// is never quietly written off while the system still has drives left.
// ════════════════════════════════════════════════════════════════════════

describe('the held ask stays OWED for the whole ladder', () => {
  it('a blocked ask is not closed by a finalize that delivered nothing', () => {
    const askId = claimedAsk('m-1', 7);
    openJoin(askId, 2);
    seedDelivery('d-reply', { turn: 7, displayKind: 'agent-text' });
    settleAsksForDelivery({
      agentId: AGENT, turnNumber: 7, deliveryId: 'd-reply', conversationId: CONV,
      tool: 'dashboard', outcome: 'delivered',
    });
    expect(workRow(askId).state).toBe('blocked');
    const r = settleAsk(askId, { agentId: AGENT, turnNumber: 12, at: 'finalize' });
    expect(r.verdict).toBe('held');
    expect(workRow(askId).state).toBe('blocked');
  });
});
