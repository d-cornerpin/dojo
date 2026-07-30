// PHASE-2 T4 Step 1 — fan-out is parent/child rows with an atomic countdown.
//
// Requirements 3a–3l of research 07-FULL, encoded verbatim, each with a NEGATIVE CONTROL
// beside its positive control (a clause that cannot fail is not a guard):
//
//   3a  park -> first-class parent/child with an N-way join; atomic decrement; parent
//       wakes at 0.
//   3b  compile-pending is a DISTINCT state between "the pieces landed" and "the owner
//       got the answer".
//   3c  the decrement is TRANSACTIONAL. The mechanism it replaces retried a
//       compare-and-swap five times and then silently returned 'noop' — a lost piece was
//       merely unlikely. Here it is impossible: one statement, in the child's own
//       transaction, guarded at zero.
//   3d  TTL fail-closed, exactly once, with no model involvement.
//   3e  abandonment covers fan-out children — and an abandoned child fails the parent
//       HONESTLY rather than compiling a lie out of the pieces that did land.
//   3f  a failed-closed join re-opens for a late answer.
//   3g  work state and conversation identity are SEPARATE fields on the same record.
//   3h  a piece's result is a real field on the child, not a row in a fake namespace.
//   3i  answered-by is an explicit edge (`result_delivery_id`), not string inference.
//   3j  no short-token parks; a real FK.
//   3k  the queue index is (agent_id, state, kind).
//   3l  the conversation-identity half stays first-class — delegating never overwrites it.
//       PHASE-2 T10I: that identity is `messages.conversation_id` (`conv_key` dropped at
//       migration `148`). The requirement is unchanged and the clauses below moved with it.
//
// Two more properties the plan names in the same breath, and both were REAL DEFECTS of
// the string machine (07 §3 "Defects" i–iii):
//   * an EMPTY terminal reply never advances the join;
//   * a terminal FAIL counts as LANDED (the piece came back; the answer is "it failed").

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
    getDbPath: () => path.join(os.tmpdir(), 'dojo-work-fanout-test', 'dojo.db'),
  };
});

import { runMigrations } from '../../db/migrations.js';
import {
  openAsk, claimAsk, askIdForMessage,
  openDelegationJoin, findJoinChildByThread, landPiece, settlePieceWithoutResult,
  joinState, joinPieces, dueJoins, failJoinClosed, settleJoinDelivered,
  reopenJoinForLateAnswer, threadHopCount, bumpThreadHopCount, THREAD_HOP_CAP,
  dueJoinsUnderClosedParent, JOIN_MAX_AGE_DAYS, transition,
} from '../store.js';

const AGENT = 'kevin';
const T1 = 'thread-aaaaaaaa-1111';
const T2 = 'thread-bbbbbbbb-2222';
const T3 = 'thread-cccccccc-3333';

const row = (id: string): Record<string, unknown> | undefined =>
  mockDb.current!.prepare('SELECT * FROM work WHERE id = ?').get(id) as Record<string, unknown> | undefined;
const events = (workId: string): Array<{ kind: string; payload: string | null }> =>
  mockDb.current!.prepare('SELECT kind, payload FROM work_events WHERE work_id = ? ORDER BY id')
    .all(workId) as Array<{ kind: string; payload: string | null }>;

/** A delivery row the child can point at. `done` is unreachable without one, which is the
 *  whole design — so the fixture has to mint them rather than hand-wave. */
function seedDelivery(id: string, over: Record<string, unknown> = {}): string {
  const r = {
    id, agent_id: AGENT, turn_number: 7, tool: 'send_to_agent', channel: 'a2a',
    conversation_id: null, outcome: 'delivered', ...over,
  };
  const cols = Object.keys(r);
  mockDb.current!.prepare(
    `INSERT INTO deliveries (${cols.join(', ')}) VALUES (${cols.map((c) => '@' + c).join(', ')})`,
  ).run(r);
  return id;
}

/** The owner's ask, claimed by the turn that is about to delegate — the exact state the
 *  delegation exit runs in. */
function seedClaimedAsk(messageId = 'm-1'): string {
  mockDb.current!.prepare(
    `INSERT INTO messages (id, agent_id, role, content, lane, channel, conversation_id, created_at, seq)
     VALUES (?, ?, 'user', 'ask Ana and Bo, then tell me', 'owner', 'dashboard', 'conv-1', ?, NULL)`,
  ).run(messageId, AGENT, Date.now());
  const id = openAsk({
    agentId: AGENT, messageId, conversationId: 'conv-1', requesterId: 'owner',
    openedAt: Date.now(), title: 'ask Ana and Bo',
  });
  claimAsk(id, AGENT);
  return id;
}

beforeEach(() => {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  mockDb.current = db;
  runMigrations();
  db.pragma('foreign_keys = ON');
  db.prepare(
    `INSERT INTO agents (id, name, status, session_started_at)
     VALUES (?, 'Kevin', 'idle', '1970-01-01'), ('ana', 'Ana', 'idle', '1970-01-01')`,
  ).run(AGENT);
  db.prepare(
    `INSERT INTO conversations (id, agent_id, channel, counterparty_id)
     VALUES ('conv-1', ?, 'dashboard', 'owner'), ('conv-2', ?, 'imessage', '+15550000')`,
  ).run(AGENT, AGENT);
});

// ════════════════════════════════════════════════════════════════════════
// 3a — parent/child with an N-way join
// ════════════════════════════════════════════════════════════════════════

describe('3a: the fan-out is N child rows under the ask, with a countdown', () => {
  it('POSITIVE: three delegated threads open three children with parent_id set and remaining_children = 3', () => {
    const parent = seedClaimedAsk();
    const kids = openDelegationJoin({
      parentWorkId: parent, agentId: AGENT, replyConversationId: 'conv-1',
      ttlAt: Date.now() + 60 * 60_000,
      threads: [{ threadId: T1 }, { threadId: T2 }, { threadId: T3 }],
    });
    expect(kids).toHaveLength(3);
    expect(row(parent)!.remaining_children).toBe(3);
    for (const k of kids) {
      const c = row(k)!;
      expect(c.parent_id).toBe(parent);
      expect(c.kind).toBe('task');
      expect(c.state).toBe('open');
    }
    // 3j: the thread reference is the FULL id on a real column, never an 8-char token.
    const roots = kids.map((k) => String(row(k)!.root_id)).sort();
    expect(roots).toEqual([T1, T2, T3].sort());
    expect(roots.every((r) => r.length > 8)).toBe(true);
  });

  it('NEGATIVE: a single delegated thread is still a child row, not a special case', () => {
    const parent = seedClaimedAsk();
    const kids = openDelegationJoin({
      parentWorkId: parent, agentId: AGENT, replyConversationId: 'conv-1',
      ttlAt: Date.now() + 60 * 60_000, threads: [{ threadId: T1 }],
    });
    expect(kids).toHaveLength(1);
    expect(row(parent)!.remaining_children).toBe(1);
    expect(row(kids[0])!.parent_id).toBe(parent);
  });

  it('NEGATIVE: opening a join with zero threads changes nothing — no children, no countdown', () => {
    const parent = seedClaimedAsk();
    const kids = openDelegationJoin({
      parentWorkId: parent, agentId: AGENT, replyConversationId: 'conv-1',
      ttlAt: Date.now() + 60 * 60_000, threads: [],
    });
    expect(kids).toHaveLength(0);
    expect(row(parent)!.remaining_children).toBeNull();
  });

  it('POSITIVE: the parent wakes at 0 — the LAST piece, and only the last, completes the join', () => {
    const parent = seedClaimedAsk();
    const kids = openDelegationJoin({
      parentWorkId: parent, agentId: AGENT, replyConversationId: 'conv-1',
      ttlAt: Date.now() + 60 * 60_000, threads: [{ threadId: T1 }, { threadId: T2 }],
    });
    const a = landPiece(findJoinChildByThread(AGENT, T1)!.id, {
      deliveryId: seedDelivery('d-1'), content: 'Ana says: 42', messageId: null,
    });
    expect(a.join.remaining).toBe(1);
    expect(a.join.complete).toBe(false);
    expect(row(parent)!.compile_pending).toBe(0);

    const b = landPiece(findJoinChildByThread(AGENT, T2)!.id, {
      deliveryId: seedDelivery('d-2'), content: 'Bo says: blue', messageId: null,
    });
    expect(b.join.remaining).toBe(0);
    expect(b.join.complete).toBe(true);
    expect(kids).toHaveLength(2);
  });
});

// ════════════════════════════════════════════════════════════════════════
// 3c — the decrement is transactional, and there is no silent give-up
// ════════════════════════════════════════════════════════════════════════

describe('3c: a lost piece is impossible, not unlikely', () => {
  it('POSITIVE: every land decrements exactly once — remaining always equals total minus landed', () => {
    const parent = seedClaimedAsk();
    openDelegationJoin({
      parentWorkId: parent, agentId: AGENT, replyConversationId: 'conv-1',
      ttlAt: Date.now() + 60 * 60_000,
      threads: [{ threadId: T1 }, { threadId: T2 }, { threadId: T3 }],
    });
    const order = [T1, T2, T3];
    order.forEach((t, i) => {
      landPiece(findJoinChildByThread(AGENT, t)!.id, {
        deliveryId: seedDelivery(`d-${i}`), content: `piece ${i}`, messageId: null,
      });
      expect(joinState(parent)!.remaining).toBe(3 - (i + 1));
    });
    expect(joinState(parent)!.landed).toBe(3);
  });

  it('NEGATIVE: a DUPLICATE reply on a thread already landed does not decrement a second time', () => {
    const parent = seedClaimedAsk();
    openDelegationJoin({
      parentWorkId: parent, agentId: AGENT, replyConversationId: 'conv-1',
      ttlAt: Date.now() + 60 * 60_000, threads: [{ threadId: T1 }, { threadId: T2 }],
    });
    const child = findJoinChildByThread(AGENT, T1)!.id;
    landPiece(child, { deliveryId: seedDelivery('d-1'), content: 'first', messageId: null });
    expect(joinState(parent)!.remaining).toBe(1);
    // The same thread replies again. findJoinChildByThread no longer offers it (it is
    // settled), and forcing the settled child through anyway is a NO-OP, never a decrement.
    expect(findJoinChildByThread(AGENT, T1)).toBeNull();
    const again = landPiece(child, { deliveryId: seedDelivery('d-1b'), content: 'again', messageId: null });
    expect(again.result.kind).toBe('noop');
    expect(joinState(parent)!.remaining).toBe(1);
  });

  it('NEGATIVE: the countdown can never go below zero, even when the count disagrees with the children', () => {
    const parent = seedClaimedAsk();
    openDelegationJoin({
      parentWorkId: parent, agentId: AGENT, replyConversationId: 'conv-1',
      ttlAt: Date.now() + 60 * 60_000, threads: [{ threadId: T1 }, { threadId: T2 }],
    });
    // Force the drift the guard exists for: MORE children than the count says are outstanding.
    // (A re-opened join, a hand-edited row, a future task that adds a child — the guard must
    // not depend on nobody ever making that mistake.)
    mockDb.current!.prepare('UPDATE work SET remaining_children = 1 WHERE id = ?').run(parent);
    landPiece(findJoinChildByThread(AGENT, T1)!.id, {
      deliveryId: seedDelivery('d-1'), content: 'first', messageId: null,
    });
    expect(joinState(parent)!.remaining).toBe(0);
    landPiece(findJoinChildByThread(AGENT, T2)!.id, {
      deliveryId: seedDelivery('d-2'), content: 'second', messageId: null,
    });
    expect(joinState(parent)!.remaining).toBe(0);
    expect(joinState(parent)!.remaining).toBeGreaterThanOrEqual(0);
  });

  it('NEGATIVE: a settled piece cannot be settled again into a different terminal state', () => {
    const parent = seedClaimedAsk();
    openDelegationJoin({
      parentWorkId: parent, agentId: AGENT, replyConversationId: 'conv-1',
      ttlAt: Date.now() + 60 * 60_000, threads: [{ threadId: T1 }],
    });
    landPiece(findJoinChildByThread(AGENT, T1)!.id, {
      deliveryId: seedDelivery('d-1'), content: 'only piece', messageId: null,
    });
    const racing = settlePieceWithoutResult(joinPieces(parent)[0].childId, {
      to: 'failed', reason: 'a racing sweep tries to fail an already-landed piece',
    });
    expect(racing.result.kind).toBe('rejected');
    expect(joinState(parent)!.remaining).toBe(0);
    expect(joinState(parent)!.landed).toBe(1);
  });
});

// ════════════════════════════════════════════════════════════════════════
// 3b — compile-pending is distinct from delivered
// ════════════════════════════════════════════════════════════════════════

describe('3b: "the pieces landed" and "the owner got the answer" are different facts', () => {
  it('POSITIVE: at zero the parent is compile_pending, and it is NOT done', () => {
    const parent = seedClaimedAsk();
    openDelegationJoin({
      parentWorkId: parent, agentId: AGENT, replyConversationId: 'conv-1',
      ttlAt: Date.now() + 60 * 60_000, threads: [{ threadId: T1 }],
    });
    landPiece(findJoinChildByThread(AGENT, T1)!.id, {
      deliveryId: seedDelivery('d-1'), content: 'the answer is 42', messageId: null,
    });
    const p = row(parent)!;
    expect(p.compile_pending).toBe(1);
    expect(p.state).not.toBe('done');
    expect(p.result_delivery_id).toBeNull();
    expect(events(parent).map((e) => e.kind)).toContain('join_complete');
  });

  it('POSITIVE: the parent leaves compile_pending only when a real delivery closes it', () => {
    const parent = seedClaimedAsk();
    openDelegationJoin({
      parentWorkId: parent, agentId: AGENT, replyConversationId: 'conv-1',
      ttlAt: Date.now() + 60 * 60_000, threads: [{ threadId: T1 }],
    });
    landPiece(findJoinChildByThread(AGENT, T1)!.id, {
      deliveryId: seedDelivery('d-1'), content: 'the answer is 42', messageId: null,
    });
    const res = settleJoinDelivered(parent, seedDelivery('d-owner', { channel: 'dashboard', conversation_id: 'conv-1' }), 'engine relayed the answer');
    expect(res.kind).toBe('applied');
    const p = row(parent)!;
    expect(p.state).toBe('done');
    expect(p.compile_pending).toBe(0);
    expect(p.result_delivery_id).toBe('d-owner');
  });

  it('NEGATIVE: a join cannot be closed done without a delivery to point at (3i)', () => {
    const parent = seedClaimedAsk();
    openDelegationJoin({
      parentWorkId: parent, agentId: AGENT, replyConversationId: 'conv-1',
      ttlAt: Date.now() + 60 * 60_000, threads: [{ threadId: T1 }],
    });
    landPiece(findJoinChildByThread(AGENT, T1)!.id, {
      deliveryId: seedDelivery('d-1'), content: 'the answer is 42', messageId: null,
    });
    const bogus = settleJoinDelivered(parent, 'no-such-delivery', 'claiming a delivery that does not exist');
    expect(bogus.kind).toBe('rejected');
    expect(row(parent)!.state).not.toBe('done');
  });
});

// ════════════════════════════════════════════════════════════════════════
// empty terminal reply / terminal FAIL
// ════════════════════════════════════════════════════════════════════════

describe('an empty terminal reply is not a deliverable, and a FAIL is', () => {
  it('NEGATIVE: an EMPTY piece never advances the join', () => {
    const parent = seedClaimedAsk();
    openDelegationJoin({
      parentWorkId: parent, agentId: AGENT, replyConversationId: 'conv-1',
      ttlAt: Date.now() + 60 * 60_000, threads: [{ threadId: T1 }, { threadId: T2 }],
    });
    const child = findJoinChildByThread(AGENT, T1)!.id;
    const empty = landPiece(child, { deliveryId: seedDelivery('d-1'), content: '   ', messageId: null });
    expect(empty.result.kind).toBe('rejected');
    expect(joinState(parent)!.remaining).toBe(2);
    // ...and the piece is STILL outstanding, so the real deliverable can land later.
    expect(findJoinChildByThread(AGENT, T1)).not.toBeNull();
    const real = landPiece(child, { deliveryId: seedDelivery('d-2'), content: 'the real one', messageId: null });
    expect(real.result.kind).toBe('applied');
    expect(joinState(parent)!.remaining).toBe(1);
  });

  it('POSITIVE: a terminal FAIL counts as LANDED — the piece came back, and the answer is "it failed"', () => {
    const parent = seedClaimedAsk();
    openDelegationJoin({
      parentWorkId: parent, agentId: AGENT, replyConversationId: 'conv-1',
      ttlAt: Date.now() + 60 * 60_000, threads: [{ threadId: T1 }, { threadId: T2 }],
    });
    const r = settlePieceWithoutResult(findJoinChildByThread(AGENT, T1)!.id, {
      to: 'failed', reason: 'the peer replied FAIL', content: 'could not reach the API',
    });
    expect(r.result.kind).toBe('applied');
    expect(joinState(parent)!.remaining).toBe(1);
    expect(joinPieces(parent).find((p) => p.threadId === T1)!.state).toBe('failed');
  });
});

// ════════════════════════════════════════════════════════════════════════
// 3e — abandonment covers fan-out children, and it fails the parent honestly
// ════════════════════════════════════════════════════════════════════════

describe('3e: an abandoned child fails the parent honestly', () => {
  it('POSITIVE: the ONLY child abandoned means the join has nothing to compile — fail closed, never compile', () => {
    const parent = seedClaimedAsk();
    openDelegationJoin({
      parentWorkId: parent, agentId: AGENT, replyConversationId: 'conv-1',
      ttlAt: Date.now() + 60 * 60_000, threads: [{ threadId: T1 }],
    });
    const r = settlePieceWithoutResult(findJoinChildByThread(AGENT, T1)!.id, {
      to: 'abandoned', reason: 'the asked agent gave up (synthetic ABANDONED)',
    });
    expect(r.join.remaining).toBe(0);
    expect(r.join.complete).toBe(true);
    // The honest outcome: nothing came back, so there is no combined reply to compose.
    expect(r.join.outcome).toBe('fail-closed');
    expect(row(parent)!.compile_pending).toBe(0);
  });

  it('POSITIVE: one abandoned piece among several that landed still completes as a COMPILE, with the failure visible', () => {
    const parent = seedClaimedAsk();
    openDelegationJoin({
      parentWorkId: parent, agentId: AGENT, replyConversationId: 'conv-1',
      ttlAt: Date.now() + 60 * 60_000, threads: [{ threadId: T1 }, { threadId: T2 }],
    });
    landPiece(findJoinChildByThread(AGENT, T1)!.id, {
      deliveryId: seedDelivery('d-1'), content: 'Ana: 42', messageId: null,
    });
    const r = settlePieceWithoutResult(findJoinChildByThread(AGENT, T2)!.id, {
      to: 'abandoned', reason: 'Bo gave up',
    });
    expect(r.join.outcome).toBe('compile');
    expect(row(parent)!.compile_pending).toBe(1);
    const pieces = joinPieces(parent);
    expect(pieces.find((p) => p.threadId === T2)!.state).toBe('abandoned');
    expect(pieces.find((p) => p.threadId === T1)!.content).toContain('42');
  });

  it('NEGATIVE: an abandoned piece while OTHERS are still outstanding does NOT complete the join', () => {
    const parent = seedClaimedAsk();
    openDelegationJoin({
      parentWorkId: parent, agentId: AGENT, replyConversationId: 'conv-1',
      ttlAt: Date.now() + 60 * 60_000,
      threads: [{ threadId: T1 }, { threadId: T2 }, { threadId: T3 }],
    });
    const r = settlePieceWithoutResult(findJoinChildByThread(AGENT, T2)!.id, {
      to: 'abandoned', reason: 'Bo gave up',
    });
    expect(r.join.complete).toBe(false);
    expect(r.join.remaining).toBe(2);
    expect(row(parent)!.compile_pending).toBe(0);
  });
});

// ════════════════════════════════════════════════════════════════════════
// 3d — TTL fail-closed, exactly once, with no model involvement
// ════════════════════════════════════════════════════════════════════════

describe('3d: the TTL reaper fails a stuck join closed exactly once', () => {
  it('POSITIVE: a join past its ttl_at is due; a fresh one is not', () => {
    const stale = seedClaimedAsk('m-stale');
    openDelegationJoin({
      parentWorkId: stale, agentId: AGENT, replyConversationId: 'conv-1',
      ttlAt: Date.now() - 1000, threads: [{ threadId: T1 }],
    });
    const fresh = seedClaimedAsk('m-fresh');
    openDelegationJoin({
      parentWorkId: fresh, agentId: AGENT, replyConversationId: 'conv-1',
      ttlAt: Date.now() + 60 * 60_000, threads: [{ threadId: T2 }],
    });
    const due = dueJoins(Date.now()).map((j) => j.id);
    expect(due).toContain(stale);
    expect(due).not.toContain(fresh);
  });

  it('POSITIVE + NEGATIVE: two reapers race; exactly ONE gets to deliver the notice', () => {
    const parent = seedClaimedAsk();
    openDelegationJoin({
      parentWorkId: parent, agentId: AGENT, replyConversationId: 'conv-1',
      ttlAt: Date.now() - 1000, threads: [{ threadId: T1 }],
    });
    const before = joinState(parent)!.parentState as never;
    const first = failJoinClosed(parent, { reason: 'TTL expired', expectedState: before });
    const second = failJoinClosed(parent, { reason: 'TTL expired', expectedState: before });
    const applied = [first, second].filter((r) => r.kind === 'applied');
    expect(applied).toHaveLength(1);
    expect(row(parent)!.state).toBe('failed');
    // The loser must be VISIBLE, not silent: it is a conflict value the caller reads.
    expect([second.kind, first.kind]).toContain('conflict');
    // ...and a failed-closed join is no longer due, so the 10-minute sweep cannot
    // deliver a second notice on the next pass.
    expect(dueJoins(Date.now()).map((j) => j.id)).not.toContain(parent);
  });

  it('NEGATIVE: a join whose pieces all landed is NOT failed closed by the reaper', () => {
    const parent = seedClaimedAsk();
    openDelegationJoin({
      parentWorkId: parent, agentId: AGENT, replyConversationId: 'conv-1',
      ttlAt: Date.now() - 1000, threads: [{ threadId: T1 }],
    });
    landPiece(findJoinChildByThread(AGENT, T1)!.id, {
      deliveryId: seedDelivery('d-1'), content: 'landed in time', messageId: null,
    });
    const due = dueJoins(Date.now());
    expect(due.map((j) => j.id)).toContain(parent);
    // ...but it is due for COMPILE resolution, not for a "could not get an answer"
    // notice: the reaper reads the same outcome the countdown computed.
    expect(joinState(parent)!.outcome).toBe('compile');
  });
});

// ════════════════════════════════════════════════════════════════════════
// 3d, SECOND ARM — issues-log #19: the parent closing must not silence the deadline
//
// THE DEFECT. The parent ask closes on the reply the agent sends the owner (T5's
// `closeAsksForDelivery`) and the join is opened in the SAME turn — in the event log
// `join_opened` lands AFTER the `claimed -> done` transition. So EVERY delegating turn
// leaves a `done` parent with a live countdown. Both timeout finders (`dueJoins`, the
// 10-minute reaper's input, and `openJoins`, the boot re-drain's) carried
// `state NOT IN ('done','failed','abandoned')` on the PARENT, so neither ever yielded one:
// T11 measured 14 delegated pieces open 8–13 HOURS past their TTL under 13 done parents,
// and the fail-closed owner notice was never sent. A late reply still LANDS (`landPiece`
// works fine under a terminal parent), so the row was reachable by the peer and by nothing
// else — the person who asked is simply never told their delegated half did not come back.
//
// THE SHAPE OF THE FIX, and why it is keyed on the CHILD. `failJoinClosed` transitions the
// PARENT and takes the parent's current state as its exactly-once guard, so it cannot run
// here: `done -> failed` is a terminal-to-terminal move this state machine does not make,
// and teaching it to would let any reaper re-open a delivered answer. The second arm settles
// the OUTSTANDING PIECES instead — which is a move the machine already makes, decrements the
// same countdown, and leaves the parent's delivered outcome untouched. The child transition
// IS the exactly-once guard, exactly as the parent transition is for the first arm.
// ════════════════════════════════════════════════════════════════════════

describe('3d second arm: a deadline still expires when the parent ask has already closed', () => {
  /** The exact shape T11 measured: parent delivered and `done`, countdown still running. */
  function seedOrphanedJoin(
    msgId: string, opts: { ttlAt: number; threads?: string[] } = { ttlAt: Date.now() - 1000 },
  ): string {
    const parent = seedClaimedAsk(msgId);
    openDelegationJoin({
      parentWorkId: parent, agentId: AGENT, replyConversationId: 'conv-1',
      ttlAt: opts.ttlAt, threads: (opts.threads ?? [T1]).map((threadId) => ({ threadId })),
    });
    // The agent answered the owner; the ask closes on that delivery. This is T5's own path,
    // not a contrivance — `transition(..., to: 'done')` with a real delivery to point at.
    // `evidenceRef` is not decoration: G6 refuses `by:'engine'` without it, which is the gate
    // that stops the engine closing work it cannot point at.
    const owner = seedDelivery('d-owner-' + msgId, { channel: 'dashboard' });
    const r = transition(parent, {
      to: 'done', by: 'engine', actorId: 'engine',
      reason: 'delivered via dashboard',
      evidenceRef: owner, resultDeliveryId: owner,
    });
    expect(r.kind).toBe('applied');
    return parent;
  }

  it('POSITIVE: a past-TTL join under a CLOSED parent is found by the second arm', () => {
    const parent = seedOrphanedJoin('m-orphan');
    expect(row(parent)!.state).toBe('done');
    expect(row(parent)!.remaining_children).toBe(1);
    expect(dueJoinsUnderClosedParent(Date.now()).map((j) => j.id)).toContain(parent);
  });

  it('NEGATIVE: the FIRST arm still does not see it — the two arms are disjoint, not duplicated', () => {
    const parent = seedOrphanedJoin('m-orphan');
    expect(dueJoins(Date.now()).map((j) => j.id)).not.toContain(parent);
  });

  it('NEGATIVE: an OPEN parent past its TTL belongs to the first arm only', () => {
    const parent = seedClaimedAsk('m-open');
    openDelegationJoin({
      parentWorkId: parent, agentId: AGENT, replyConversationId: 'conv-1',
      ttlAt: Date.now() - 1000, threads: [{ threadId: T1 }],
    });
    expect(dueJoins(Date.now()).map((j) => j.id)).toContain(parent);
    expect(dueJoinsUnderClosedParent(Date.now()).map((j) => j.id)).not.toContain(parent);
  });

  it('NEGATIVE: a closed parent whose deadline has NOT passed is left alone', () => {
    const parent = seedOrphanedJoin('m-fresh', { ttlAt: Date.now() + 60 * 60_000 });
    expect(dueJoinsUnderClosedParent(Date.now()).map((j) => j.id)).not.toContain(parent);
  });

  it('NEGATIVE: a closed parent whose countdown already reached zero is NOT outstanding', () => {
    const parent = seedOrphanedJoin('m-landed');
    landPiece(findJoinChildByThread(AGENT, T1)!.id, {
      deliveryId: seedDelivery('d-piece'), content: 'came back late but it came back', messageId: null,
    });
    expect(row(parent)!.remaining_children).toBe(0);
    expect(dueJoinsUnderClosedParent(Date.now()).map((j) => j.id)).not.toContain(parent);
  });

  it('NEGATIVE: a closed ask that never delegated at all is never in either arm', () => {
    const plain = seedClaimedAsk('m-plain');
    const plainDelivery = seedDelivery('d-plain', { channel: 'dashboard' });
    transition(plain, {
      to: 'done', by: 'engine', actorId: 'engine', reason: 'answered',
      evidenceRef: plainDelivery, resultDeliveryId: plainDelivery,
    });
    expect(row(plain)!.remaining_children).toBeNull();
    expect(dueJoinsUnderClosedParent(Date.now()).map((j) => j.id)).not.toContain(plain);
    expect(dueJoins(Date.now()).map((j) => j.id)).not.toContain(plain);
  });

  it('POSITIVE: settling the outstanding piece is a move the machine MAKES — the countdown '
    + 'moves and the parent\'s delivered outcome is untouched', () => {
    const parent = seedOrphanedJoin('m-settle');
    const child = findJoinChildByThread(AGENT, T1)!.id;
    const before = row(parent)!;
    const r = settlePieceWithoutResult(child, {
      to: 'abandoned', reason: 'the deadline passed and the parent had already closed',
    });
    expect(r.result.kind).toBe('applied');
    expect(row(child)!.state).toBe('abandoned');
    const after = row(parent)!;
    expect(after.remaining_children).toBe(0);
    // The parent is EXACTLY as it was on every fact that describes the owner's answer.
    expect(after.state).toBe('done');
    expect(after.state).toBe(before.state);
    expect(after.result_delivery_id).toBe(before.result_delivery_id);
    expect(after.closed_at).toBe(before.closed_at);
    // ...and the join_complete event records the honest outcome: nothing landed.
    const jc = events(parent).filter((e) => e.kind === 'join_complete');
    expect(jc).toHaveLength(1);
    expect(JSON.parse(jc[0].payload!)).toMatchObject({ landed: 0, outcome: 'fail-closed' });
  });

  it('POSITIVE + NEGATIVE: the CHILD settle is the exactly-once guard — a second reaper pass '
    + 'finds nothing to settle and the arm goes empty', () => {
    const parent = seedOrphanedJoin('m-once');
    const child = findJoinChildByThread(AGENT, T1)!.id;
    const first = settlePieceWithoutResult(child, { to: 'abandoned', reason: 'deadline' });
    const second = settlePieceWithoutResult(child, { to: 'abandoned', reason: 'deadline' });
    expect(first.result.kind).toBe('applied');
    expect(second.result.kind).not.toBe('applied');
    expect(row(parent)!.remaining_children).toBe(0);
    expect(dueJoinsUnderClosedParent(Date.now()).map((j) => j.id)).not.toContain(parent);
  });

  it('POSITIVE: a PARTIAL fan-out under a closed parent settles only what is outstanding', () => {
    const parent = seedOrphanedJoin('m-partial', { ttlAt: Date.now() - 1000, threads: [T1, T2] });
    landPiece(findJoinChildByThread(AGENT, T1)!.id, {
      deliveryId: seedDelivery('d-t1'), content: 'T1 answered', messageId: null,
    });
    expect(row(parent)!.remaining_children).toBe(1);
    expect(dueJoinsUnderClosedParent(Date.now()).map((j) => j.id)).toContain(parent);
    const st = joinState(parent)!;
    expect(st.landed).toBe(1);
    expect(st.outcome).toBe('compile');   // something DID come back; the notice must say so
    const outstanding = joinPieces(parent).filter((p) => p.state === 'open');
    expect(outstanding).toHaveLength(1);
    expect(outstanding[0].threadId).toBe(T2);
  });

  it('NEGATIVE: the age cap applies to this arm too — a join older than the window is not '
    + 'resurrected months later', () => {
    const parent = seedOrphanedJoin('m-ancient');
    const ancient = Date.now() - (JOIN_MAX_AGE_DAYS + 1) * 24 * 60 * 60 * 1000;
    mockDb.current!.prepare('UPDATE work SET opened_at = ? WHERE id = ?').run(ancient, parent);
    expect(dueJoinsUnderClosedParent(Date.now()).map((j) => j.id)).not.toContain(parent);
  });
});

// ════════════════════════════════════════════════════════════════════════
// 3f — a failed-closed join re-opens for a late answer
// ════════════════════════════════════════════════════════════════════════

describe('3f: an answer arriving after the failure notice still reaches the owner, once', () => {
  it('POSITIVE: the late answer reopens the failed join and closes it done, both moves recorded', () => {
    const parent = seedClaimedAsk();
    openDelegationJoin({
      parentWorkId: parent, agentId: AGENT, replyConversationId: 'conv-1',
      ttlAt: Date.now() - 1000, threads: [{ threadId: T1 }],
    });
    failJoinClosed(parent, { reason: 'TTL expired', expectedState: 'claimed' });
    expect(row(parent)!.state).toBe('failed');

    const d = seedDelivery('d-late', { channel: 'dashboard', conversation_id: 'conv-1' });
    const r = reopenJoinForLateAnswer(parent, d, 'Ana answered after all');
    expect(r.kind).toBe('applied');
    const p = row(parent)!;
    expect(p.state).toBe('done');
    expect(p.result_delivery_id).toBe('d-late');
    const kinds = events(parent).map((e) => e.kind);
    expect(kinds.filter((k) => k === 'transition').length).toBeGreaterThanOrEqual(4);
  });

  it('NEGATIVE: a SECOND late answer does not re-deliver — the reopen is refused on a settled join', () => {
    const parent = seedClaimedAsk();
    openDelegationJoin({
      parentWorkId: parent, agentId: AGENT, replyConversationId: 'conv-1',
      ttlAt: Date.now() - 1000, threads: [{ threadId: T1 }],
    });
    failJoinClosed(parent, { reason: 'TTL expired', expectedState: 'claimed' });
    reopenJoinForLateAnswer(parent, seedDelivery('d-late', { channel: 'dashboard', conversation_id: 'conv-1' }), 'first late answer');
    const second = reopenJoinForLateAnswer(parent, seedDelivery('d-later', { channel: 'dashboard', conversation_id: 'conv-1' }), 'second late answer');
    expect(second.kind).not.toBe('applied');
    expect(row(parent)!.result_delivery_id).toBe('d-late');
  });

  it('NEGATIVE: a join that never failed closed is not "reopened" by a late answer', () => {
    const parent = seedClaimedAsk();
    openDelegationJoin({
      parentWorkId: parent, agentId: AGENT, replyConversationId: 'conv-1',
      ttlAt: Date.now() + 60 * 60_000, threads: [{ threadId: T1 }],
    });
    const r = reopenJoinForLateAnswer(parent, seedDelivery('d-x', { channel: 'dashboard', conversation_id: 'conv-1' }), 'not a late answer');
    expect(r.kind).toBe('conflict');
    expect(row(parent)!.state).toBe('claimed');
  });
});

// ════════════════════════════════════════════════════════════════════════
// 3g / 3l — state and conversation identity are separate fields
// ════════════════════════════════════════════════════════════════════════

describe('3g + 3l: delegating never overwrites the conversation identity', () => {
  it('POSITIVE: the reply conversation is COPIED onto the join at park time, on parent and children', () => {
    const parent = seedClaimedAsk();
    const kids = openDelegationJoin({
      parentWorkId: parent, agentId: AGENT, replyConversationId: 'conv-2',
      ttlAt: Date.now() + 60 * 60_000, threads: [{ threadId: T1 }, { threadId: T2 }],
    });
    expect(row(parent)!.reply_conversation_id).toBe('conv-2');
    for (const k of kids) expect(row(k)!.reply_conversation_id).toBe('conv-2');
  });

  it('POSITIVE: the owner message keeps its own conversation through the whole join', () => {
    const parent = seedClaimedAsk();
    // The join's reply conversation is DELIBERATELY a different one from the ask's, so this
    // clause cannot pass by the two being equal — the requirement is that delegating does not
    // overwrite the ask row's own identity (3g/3l), and that needs two distinct values.
    openDelegationJoin({
      parentWorkId: parent, agentId: AGENT, replyConversationId: 'conv-2',
      ttlAt: Date.now() + 60 * 60_000, threads: [{ threadId: T1 }],
    });
    landPiece(findJoinChildByThread(AGENT, T1)!.id, {
      deliveryId: seedDelivery('d-1'), content: 'x', messageId: null,
    });
    settleJoinDelivered(parent, seedDelivery('d-owner', { channel: 'dashboard', conversation_id: 'conv-1' }), 'relayed');
    const m = mockDb.current!.prepare('SELECT conversation_id FROM messages WHERE id = ?').get('m-1') as { conversation_id: string };
    expect(m.conversation_id).toBe('conv-1');
  });

  it('NEGATIVE: a reply conversation that is not a real conversation row is recorded as absent, never as a park sigil', () => {
    const parent = seedClaimedAsk();
    openDelegationJoin({
      parentWorkId: parent, agentId: AGENT, replyConversationId: null,
      ttlAt: Date.now() + 60 * 60_000, threads: [{ threadId: T1 }],
    });
    expect(row(parent)!.reply_conversation_id).toBeNull();
    const m = mockDb.current!.prepare('SELECT conversation_id FROM messages WHERE id = ?').get('m-1') as { conversation_id: string };
    expect(m.conversation_id).toBe('conv-1');
    // PHASE-2 T10I: the sigil is no longer merely unwritten, it is UNREPRESENTABLE — the column
    // it lived in is gone, and a uuid FK cannot hold `park:~…`. Asserted against the schema,
    // which is strictly stronger than asserting the value's absence.
    expect(mockDb.current!.prepare(
      "SELECT count(*) AS c FROM pragma_table_info('messages') WHERE name = 'conv_key'",
    ).get()).toEqual({ c: 0 });
  });
});

// ════════════════════════════════════════════════════════════════════════
// 3h + 3i — the piece's result is a real field, and the answered edge is explicit
// ════════════════════════════════════════════════════════════════════════

describe('3h + 3i: a piece result is a child field, not a row in a fake namespace', () => {
  it('POSITIVE: the landed child carries result_delivery_id, and the harvest reads the children', () => {
    const parent = seedClaimedAsk();
    openDelegationJoin({
      parentWorkId: parent, agentId: AGENT, replyConversationId: 'conv-1',
      ttlAt: Date.now() + 60 * 60_000, threads: [{ threadId: T1 }, { threadId: T2 }],
    });
    landPiece(findJoinChildByThread(AGENT, T1)!.id, {
      deliveryId: seedDelivery('d-1'), content: 'Ana: the code is 4417', messageId: 'msg-a',
    });
    landPiece(findJoinChildByThread(AGENT, T2)!.id, {
      deliveryId: seedDelivery('d-2'), content: 'Bo: the colour is blue', messageId: 'msg-b',
    });
    const pieces = joinPieces(parent);
    expect(pieces).toHaveLength(2);
    expect(pieces.map((p) => p.resultDeliveryId).sort()).toEqual(['d-1', 'd-2']);
    expect(pieces.map((p) => p.content).join(' ')).toContain('4417');
    expect(pieces.map((p) => p.content).join(' ')).toContain('blue');
    // The harvest never reads a fake namespace, and after PHASE-2 T10I there is no column left
    // to hold one: `messages.conv_key` is dropped at `148`. The old form of this clause
    // (`WHERE conv_key LIKE 'join-piece:%'`) would now THROW rather than assert — a check
    // dying because its subject left the schema. This asserts the absence at the schema level.
    expect(mockDb.current!.prepare(
      "SELECT count(*) AS c FROM pragma_table_info('messages') WHERE name = 'conv_key'",
    ).get()).toEqual({ c: 0 });
  });

  it('NEGATIVE: a piece cannot be landed with a delivery id that resolves to nothing', () => {
    const parent = seedClaimedAsk();
    openDelegationJoin({
      parentWorkId: parent, agentId: AGENT, replyConversationId: 'conv-1',
      ttlAt: Date.now() + 60 * 60_000, threads: [{ threadId: T1 }],
    });
    const r = landPiece(findJoinChildByThread(AGENT, T1)!.id, {
      deliveryId: 'not-a-delivery', content: 'Ana: 42', messageId: null,
    });
    expect(r.result.kind).toBe('rejected');
    expect(joinState(parent)!.remaining).toBe(1);
  });
});

// ════════════════════════════════════════════════════════════════════════
// 3j + 3k — real FK, real index
// ════════════════════════════════════════════════════════════════════════

describe('3j + 3k: a real FK and the queue index', () => {
  it('POSITIVE: parent_id is a real foreign key — a child cannot point at a parent that does not exist', () => {
    expect(() => mockDb.current!.prepare(
      `INSERT INTO work (id, kind, parent_id, agent_id, requester, root_kind, root_id, state,
                         intent, wakes, closes_thread, opened_at, updated_at)
       VALUES ('orphan', 'task', 'no-such-parent', ?, 'agent', 'a2a_thread', ?, 'open',
               'ASSIGN', 1, 0, ?, ?)`,
    ).run(AGENT, T1, Date.now(), Date.now())).toThrow(/FOREIGN KEY/i);
  });

  it('POSITIVE: the queue index is (agent_id, state, kind)', () => {
    const idx = mockDb.current!.prepare(
      "SELECT sql FROM sqlite_master WHERE type='index' AND name='ix_work_queue'",
    ).get() as { sql: string } | undefined;
    expect(idx?.sql.replace(/\s+/g, ' ')).toMatch(/work\(agent_id, state, kind\)/);
  });

  it('NEGATIVE: the thread reference is matched EXACTLY — an 8-char prefix resolves nothing', () => {
    const parent = seedClaimedAsk();
    openDelegationJoin({
      parentWorkId: parent, agentId: AGENT, replyConversationId: 'conv-1',
      ttlAt: Date.now() + 60 * 60_000, threads: [{ threadId: T1 }],
    });
    expect(findJoinChildByThread(AGENT, T1)).not.toBeNull();
    expect(findJoinChildByThread(AGENT, T1.slice(0, 8))).toBeNull();
  });
});

// ════════════════════════════════════════════════════════════════════════
// D2 — the transport's hop cap dissolves onto work.hop_count
// ════════════════════════════════════════════════════════════════════════

describe('D2: the delegated thread carries its own hop count on the spine', () => {
  it('POSITIVE: the child records the thread hop count and it increments on the spine', () => {
    const parent = seedClaimedAsk();
    openDelegationJoin({
      parentWorkId: parent, agentId: AGENT, replyConversationId: 'conv-1',
      ttlAt: Date.now() + 60 * 60_000, threads: [{ threadId: T1, hopCount: 2 }],
    });
    expect(threadHopCount(T1)).toBe(2);
    expect(bumpThreadHopCount(T1)).toBe(3);
    expect(threadHopCount(T1)).toBe(3);
  });

  it('NEGATIVE: a thread with no work row has no spine hop count, and says so rather than answering 0', () => {
    expect(threadHopCount('thread-unknown-9999')).toBeNull();
    expect(bumpThreadHopCount('thread-unknown-9999')).toBeNull();
  });

  it('the cap is declared once, beside the column it keys on', () => {
    expect(THREAD_HOP_CAP).toBe(8);
  });
});
