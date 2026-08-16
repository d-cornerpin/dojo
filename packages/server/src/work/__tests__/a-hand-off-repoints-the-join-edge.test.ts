// UX-REPAIR ROUND 11 · T43 leg (c) — A PUNT CANNOT SILENTLY SATISFY THE JOIN
//
// ── THE RECORDED INCIDENT (round-11 S5-A) ──
// BehaviorBot delegated research to kelly, the PM, who holds no web tools. Kelly punted the
// work to kevin and replied to BehaviorBot with a hand-off note. `landPiece` settled her piece
// `done` on that note — "the delegated piece came back" — the countdown reached zero with ONE
// research stream in hand, and the compile steer told the model the pieces were back. ~6m20s
// were then spent recovering by hand.
//
// ── WHY THE VERB FIX IS NOT THE FIX (measured, and NOT-DOING) ──
// `a2a_replies` intents on the dev body: ANSWER 341 · DELIVERABLE 262 · COMPLETE 42 · FAIL 2.
// "only COMPLETE settles" would break the dominant working flow. So ANSWER still settles, and
// the assignee gets a DECLARED way to say "this is a hand-off, not the deliverable" instead.
//
// ── WHAT THIS FILE PINS ──
// The spine half: `repointJoinPieceToHandOff` moves the join edge onto the new thread and
// leaves everything else exactly where it was. The transport half (the reply that does NOT
// settle, the footer that advertises the argument) is
// `agent/__tests__/the-hand-off-does-not-discharge-the-assignment.test.ts`.
//
// EVERY REFUSAL HAS ITS OWN CLAUSE, because a repoint is a write onto somebody ELSE's join:
// only the piece's own assignee may move it, only onto a thread that is not already a piece,
// and only while the chain is inside `THREAD_HOP_CAP`.

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
    getDbPath: () => path.join(os.tmpdir(), 'dojo-work-handoff-test', 'dojo.db'),
  };
});

import { runMigrations } from '../../db/migrations.js';
import {
  openAsk, claimAsk, openDelegationJoin, findJoinChildByThread, landPiece,
  joinState, joinPieces, repointJoinPieceToHandOff, threadHopCount, THREAD_HOP_CAP,
} from '../store.js';

/** The delegator — the join is theirs, and it stays theirs. */
const OWNER_AGENT = 'behaviorbot';
/** The assignee who is handing the work on. */
const PUNTER = 'kelly';
/** The agent the work actually goes to. */
const DOER = 'kevin';

const T_ASSIGN = 'thread-aaaaaaaa-1111';   // BehaviorBot -> kelly
const T_HANDOFF = 'thread-bbbbbbbb-2222';  // kelly -> kevin
const T_OTHER = 'thread-cccccccc-3333';

const row = (id: string): Record<string, unknown> =>
  mockDb.current!.prepare('SELECT * FROM work WHERE id = ?').get(id) as Record<string, unknown>;
const events = (workId: string): Array<{ kind: string; payload: string | null; actor: string | null }> =>
  mockDb.current!.prepare('SELECT kind, payload, actor FROM work_events WHERE work_id = ? ORDER BY id')
    .all(workId) as Array<{ kind: string; payload: string | null; actor: string | null }>;

function seedDelivery(id: string, over: Record<string, unknown> = {}): string {
  const r = {
    id, agent_id: OWNER_AGENT, turn_number: 7, tool: 'send_to_agent', channel: 'a2a',
    conversation_id: null, outcome: 'delivered', ...over,
  };
  const cols = Object.keys(r);
  mockDb.current!.prepare(
    `INSERT INTO deliveries (${cols.join(', ')}) VALUES (${cols.map((c) => '@' + c).join(', ')})`,
  ).run(r);
  return id;
}

/** The owner's ask, claimed by the delegating turn. */
function seedClaimedAsk(messageId = 'm-1'): string {
  mockDb.current!.prepare(
    `INSERT INTO messages (id, agent_id, role, content, lane, channel, conversation_id, created_at, seq)
     VALUES (?, ?, 'user', 'compare the two options for me', 'owner', 'dashboard', 'conv-1', ?, NULL)`,
  ).run(messageId, OWNER_AGENT, Date.now());
  const id = openAsk({
    agentId: OWNER_AGENT, messageId, conversationId: 'conv-1', requesterId: 'owner',
    openedAt: Date.now(), title: 'compare the two options',
  });
  claimAsk(id, OWNER_AGENT);
  return id;
}

/** The whole incident's opening state: one ask, one piece, assigned to the punter. */
function seedJoinOnePiece(opts: { hopCount?: number } = {}): { parent: string; childId: string; ttlAt: number } {
  const parent = seedClaimedAsk();
  const ttlAt = Date.now() + 60 * 60_000;
  openDelegationJoin({
    parentWorkId: parent, agentId: OWNER_AGENT, replyConversationId: 'conv-1', ttlAt,
    threads: [{ threadId: T_ASSIGN, assigneeAgent: PUNTER, intent: 'ASSIGN', hopCount: opts.hopCount ?? 1 }],
  });
  const child = findJoinChildByThread(OWNER_AGENT, T_ASSIGN)!;
  return { parent, childId: child.id, ttlAt };
}

beforeEach(() => {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  mockDb.current = db;
  runMigrations();
  db.pragma('foreign_keys = ON');
  db.prepare(
    `INSERT INTO agents (id, name, status, session_started_at)
     VALUES (?, 'BehaviorBot', 'idle', '1970-01-01'), (?, 'Kelly', 'idle', '1970-01-01'),
            (?, 'Kevin', 'idle', '1970-01-01')`,
  ).run(OWNER_AGENT, PUNTER, DOER);
  db.prepare(
    `INSERT INTO conversations (id, agent_id, channel, counterparty_id)
     VALUES ('conv-1', ?, 'dashboard', 'owner')`,
  ).run(OWNER_AGENT);
});

// ════════════════════════════════════════════════════════════════════════════════
// 1 — THE REPOINT: the edge moves, and nothing else does
// ════════════════════════════════════════════════════════════════════════════════

describe('the join edge follows the work', () => {
  it('POSITIVE: the piece is NOT settled and its thread becomes the hand-off thread', () => {
    const { parent, childId, ttlAt } = seedJoinOnePiece();
    const before = row(childId);

    const out = repointJoinPieceToHandOff({
      childId, handOffSender: PUNTER, newThreadId: T_HANDOFF, newAssignee: DOER,
    });

    expect(out.kind).toBe('repointed');
    const after = row(childId);
    // The piece is STILL OUTSTANDING — this is the whole point of the leg.
    expect(after.state).toBe('open');
    expect(after.result_delivery_id).toBeNull();
    // The edge moved.
    expect(after.root_id).toBe(T_HANDOFF);
    expect(after.assignee_agent).toBe(DOER);
    // …and the listener moved with it: the next reply arrives to the PUNTER, on the new
    // thread, so that is who the finder has to resolve it for.
    expect(after.agent_id).toBe(PUNTER);
    // The join itself is untouched: same parent, same countdown, same total.
    expect(after.parent_id).toBe(parent);
    expect(row(parent).remaining_children).toBe(1);
    expect(joinState(parent)!.landed).toBe(0);
    expect(joinState(parent)!.complete).toBe(false);
    // TTL UNCHANGED — the owner's deadline is about the work, not about the worker.
    expect(after.ttl_at).toBe(ttlAt);
    expect(after.ttl_at).toBe(before.ttl_at);
    // Identity is not state: the reply conversation is still the owner's.
    expect(after.reply_conversation_id).toBe(before.reply_conversation_id);
  });

  it('the move is RECORDED on the piece\'s own spine, with both threads named', () => {
    const { childId } = seedJoinOnePiece();
    repointJoinPieceToHandOff({
      childId, handOffSender: PUNTER, newThreadId: T_HANDOFF, newAssignee: DOER,
    });
    const audit = events(childId).filter((e) => e.kind === 'audit');
    expect(audit).toHaveLength(1);
    const payload = JSON.parse(audit[0].payload!) as Record<string, unknown>;
    expect(payload.marker).toBe('join_edge_repointed');
    expect(payload.from_thread).toBe(T_ASSIGN);
    expect(payload.to_thread).toBe(T_HANDOFF);
    expect(payload.new_assignee).toBe(DOER);
    expect(audit[0].actor).toBe(PUNTER);
  });

  it('the finder now resolves the piece for the NEW listener on the NEW thread, and not the old', () => {
    const { childId } = seedJoinOnePiece();
    repointJoinPieceToHandOff({
      childId, handOffSender: PUNTER, newThreadId: T_HANDOFF, newAssignee: DOER,
    });
    // This is exactly the lookup `landReplyOnJoin` makes when kevin's answer arrives to kelly.
    expect(findJoinChildByThread(PUNTER, T_HANDOFF)?.id).toBe(childId);
    // The old edge is gone: a late note from the punter on the original thread no longer
    // finds a piece to settle.
    expect(findJoinChildByThread(OWNER_AGENT, T_ASSIGN)).toBeNull();
  });

  it('THE REAL DELIVERABLE ON THE NEW THREAD SETTLES IT — the join completes exactly once', () => {
    const { parent, childId } = seedJoinOnePiece();
    repointJoinPieceToHandOff({
      childId, handOffSender: PUNTER, newThreadId: T_HANDOFF, newAssignee: DOER,
    });
    const settled = landPiece(findJoinChildByThread(PUNTER, T_HANDOFF)!.id, {
      deliveryId: seedDelivery('d-real', { agent_id: PUNTER }),
      content: 'Kevin: option A wins on price, option B on support.',
      messageId: null, actorId: DOER,
    });
    expect(settled.result.kind).toBe('applied');
    expect(settled.join.complete).toBe(true);
    expect(joinState(parent)!.landed).toBe(1);
    // The harvest the compile steer quotes carries the REAL deliverable, credited to the
    // agent who produced it.
    const pieces = joinPieces(parent);
    expect(pieces).toHaveLength(1);
    expect(pieces[0].content).toContain('option A wins on price');
    expect(pieces[0].assigneeAgent).toBe(DOER);
  });

  it('the hop count is CONTINUOUS across the swap — the chain is one chain', () => {
    const { childId } = seedJoinOnePiece({ hopCount: 3 });
    const out = repointJoinPieceToHandOff({
      childId, handOffSender: PUNTER, newThreadId: T_HANDOFF, newAssignee: DOER,
    });
    expect(out.kind === 'repointed' && out.hopCount).toBe(4);
    // D2's rekey: the spine is where a delegated thread's count lives, so the new thread
    // inherits the chain's count rather than starting again at zero.
    expect(threadHopCount(T_HANDOFF)).toBe(4);
    expect(threadHopCount(T_ASSIGN)).toBeNull();
  });
});

// ════════════════════════════════════════════════════════════════════════════════
// 2 — THE REFUSALS. A repoint writes on someone else's join; each gate has a clause.
// ════════════════════════════════════════════════════════════════════════════════

describe('a repoint nobody is entitled to make is refused', () => {
  it('NOT THE ASSIGNEE: a third party cannot move somebody else\'s piece', () => {
    const { childId } = seedJoinOnePiece();
    const out = repointJoinPieceToHandOff({
      childId, handOffSender: DOER, newThreadId: T_HANDOFF, newAssignee: 'someone',
    });
    expect(out.kind === 'refused' && out.reason).toBe('not-the-assignee');
    expect(row(childId).root_id).toBe(T_ASSIGN);
    expect(row(childId).assignee_agent).toBe(PUNTER);
    expect(events(childId).filter((e) => e.kind === 'audit')).toHaveLength(0);
  });

  it('HOP CAP: at the cap the chain stops, and FAIL is what the refusal names', () => {
    const { childId } = seedJoinOnePiece({ hopCount: THREAD_HOP_CAP });
    const out = repointJoinPieceToHandOff({
      childId, handOffSender: PUNTER, newThreadId: T_HANDOFF, newAssignee: DOER,
    });
    expect(out.kind === 'refused' && out.reason).toBe('hop-cap');
    expect(out.kind === 'refused' && out.detail).toContain('FAIL');
    expect(row(childId).root_id).toBe(T_ASSIGN);
    expect(row(childId).hop_count).toBe(THREAD_HOP_CAP);
  });

  it('SAME THREAD: pointing a piece at its own thread is not a hand-off', () => {
    const { childId } = seedJoinOnePiece();
    const out = repointJoinPieceToHandOff({
      childId, handOffSender: PUNTER, newThreadId: T_ASSIGN, newAssignee: DOER,
    });
    expect(out.kind === 'refused' && out.reason).toBe('same-thread');
    expect(row(childId).root_id).toBe(T_ASSIGN);
  });

  it('THREAD ALREADY A PIECE: an edge cannot be pointed at another join\'s thread', () => {
    const { childId } = seedJoinOnePiece();
    // A second, unrelated join already owns T_OTHER.
    const otherParent = seedClaimedAsk('m-2');
    openDelegationJoin({
      parentWorkId: otherParent, agentId: OWNER_AGENT, replyConversationId: 'conv-1',
      ttlAt: Date.now() + 60 * 60_000,
      threads: [{ threadId: T_OTHER, assigneeAgent: DOER, intent: 'ASSIGN' }],
    });
    const out = repointJoinPieceToHandOff({
      childId, handOffSender: PUNTER, newThreadId: T_OTHER, newAssignee: DOER,
    });
    expect(out.kind === 'refused' && out.reason).toBe('thread-taken');
    expect(row(childId).root_id).toBe(T_ASSIGN);
  });

  it('NO LIVE PIECE: a settled piece cannot be re-pointed after the fact', () => {
    const { childId } = seedJoinOnePiece();
    landPiece(childId, {
      deliveryId: seedDelivery('d-1'), content: 'here is the research', messageId: null,
    });
    expect(row(childId).state).toBe('done');
    const out = repointJoinPieceToHandOff({
      childId, handOffSender: PUNTER, newThreadId: T_HANDOFF, newAssignee: DOER,
    });
    expect(out.kind === 'refused' && out.reason).toBe('no-live-piece');
    expect(row(childId).root_id).toBe(T_ASSIGN);
  });

  it('NO SUCH ROW: an unknown child id is refused, not thrown', () => {
    const out = repointJoinPieceToHandOff({
      childId: 'piece:nope:nope', handOffSender: PUNTER, newThreadId: T_HANDOFF, newAssignee: DOER,
    });
    expect(out.kind === 'refused' && out.reason).toBe('no-live-piece');
  });

  it('EMPTY TARGET: a blank hand-off thread is refused', () => {
    const { childId } = seedJoinOnePiece();
    const out = repointJoinPieceToHandOff({
      childId, handOffSender: PUNTER, newThreadId: '   ', newAssignee: DOER,
    });
    expect(out.kind === 'refused' && out.reason).toBe('no-target');
    expect(row(childId).root_id).toBe(T_ASSIGN);
  });
});

// ════════════════════════════════════════════════════════════════════════════════
// 3 — NEGATIVE CONTROLS: the 341-case flow and the FAIL path are untouched
// ════════════════════════════════════════════════════════════════════════════════

describe('the flows this leg must not disturb', () => {
  it('CONTROL — a plain ANSWER still settles the piece, with the same reason string', () => {
    const { parent, childId } = seedJoinOnePiece();
    const settled = landPiece(childId, {
      deliveryId: seedDelivery('d-plain'), content: 'here is the research you asked for',
      messageId: null, actorId: PUNTER,
    });
    expect(settled.result.kind).toBe('applied');
    expect(row(childId).state).toBe('done');
    expect(joinState(parent)!.complete).toBe(true);
    const transitions = events(childId).filter((e) => e.kind === 'transition');
    expect(transitions.length).toBeGreaterThan(0);
    expect(transitions.at(-1)!.payload).toContain('the delegated piece came back');
  });

  it('CONTROL — the empty-piece refusal is untouched', () => {
    const { childId } = seedJoinOnePiece();
    const settled = landPiece(childId, { deliveryId: seedDelivery('d-empty'), content: '   ', messageId: null });
    expect(settled.result.kind).toBe('refused');
    expect(row(childId).state).toBe('open');
  });

  it('CONTROL — a repointed piece still fails closed on its ORIGINAL deadline', () => {
    // The hand-off does not buy the chain more time; `dueJoins` reads the parent's `ttl_at`
    // and the child's is copied from it, so an expired join is still expired after a punt.
    const { parent, childId, ttlAt } = seedJoinOnePiece();
    repointJoinPieceToHandOff({
      childId, handOffSender: PUNTER, newThreadId: T_HANDOFF, newAssignee: DOER,
    });
    expect(row(childId).ttl_at).toBe(ttlAt);
    expect(row(parent).ttl_at).toBe(ttlAt);
  });
});
