// SWEEP-A TB1 Step 1 — THE SETTLEMENT AUTHORITY'S PREDICATE, ARM BY ARM.
//
// One function decides whether an owner's ask is settled. These are its arms, each with a
// negative control of the same shape beside it, because a guard that never bit is a comment.
//
// WHAT WAS MEASURED AT THE PRE-CHANGE TREE (`3439240`), so "RED" is a number rather than a
// claim. A scratch probe drove the three arms against the old mechanism and recorded:
//   * hold-on-join           — `closeAsksForDelivery` returned 1 and left the row
//                              `state=done, remaining_children=1`;
//   * re-open-on-no-delivery — the teardown batch-claim left `m-2` at
//                              `state=claimed, claimed_by_turn=4` with its turn finalized,
//                              and nothing ever adjudicated it again (the fossil);
//   * delivery-predates-arrival — `closeAsksForDelivery` returned 1 on a delivery recorded
//                              120 SECONDS BEFORE the ask existed.
// Every clause below asserts the opposite of one of those three facts.
//
// THE GOVERNING PRIORITY (owner ruling, 2026-08-05) is what settles every tie-break here:
// "the user asks the agent to do something and it does it. Period." Ambiguous evidence errs
// toward SERVING THE ASK AGAIN — never toward silence, a parked ticket or a quiet close.
// That is why the no-evidence arm at turn finalize RE-OPENS rather than holding the claim.

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
    getDbPath: () => path.join(os.tmpdir(), 'dojo-ask-settlement-test', 'dojo.db'),
  };
});

import { runMigrations } from '../../db/migrations.js';
import { askIdForMessage, claimAsk, stampClaimingTurn, openDelegationJoin } from '../store.js';
import {
  settleAsk, settleAsksForDelivery, settleAsksAtTurnFinalize, reconcileOrphanedClaims,
  MAX_ASK_RE_SERVES, RE_SERVE_MARKER,
} from '../ask-settlement.js';
import { insertMessage } from '../../memory/message-store.js';
import { assembledContextAsks } from '../../agent/v2/counterparty.js';

const AGENT = 'kevin';
const CONV = 'conv-1';

const workFor = (messageId: string): Record<string, unknown> =>
  mockDb.current!.prepare('SELECT * FROM work WHERE id = ?').get(askIdForMessage(messageId)) as
    Record<string, unknown>;
const messageFor = (id: string): Record<string, unknown> =>
  mockDb.current!.prepare('SELECT rowid AS rowid, * FROM messages WHERE id = ?').get(id) as
    Record<string, unknown>;
const transitionsFor = (messageId: string): Array<{ to: string; reason: string }> =>
  (mockDb.current!.prepare(
    `SELECT payload FROM work_events WHERE work_id = ? AND kind = 'transition' ORDER BY id`,
  ).all(askIdForMessage(messageId)) as Array<{ payload: string }>)
    .map((r) => JSON.parse(r.payload) as { to: string; reason: string });

const ownerInbound = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  agentId: AGENT, role: 'user', content: 'can you check the roof quote?',
  lane: 'owner', channel: 'dashboard', senderId: 'owner', authorized: true,
  conversationId: CONV,
  inboundMeta: JSON.stringify({ channel: 'dashboard', relation: 'owner' }),
  ...over,
});

/** A delivery row on the ledger. `offsetSeconds` moves it relative to now, which is how the
 *  arrival-order arm is driven: a delivery recorded BEFORE the ask arrived is not its answer. */
function seedDelivery(
  id: string,
  over: { turn?: number; tool?: string; conversationId?: string | null; outcome?: string; offsetSeconds?: number } = {},
): string {
  const o = { turn: 4, tool: 'auto-route', conversationId: CONV, outcome: 'delivered', offsetSeconds: 0, ...over };
  mockDb.current!.prepare(
    `INSERT INTO deliveries (id, agent_id, turn_number, tool, channel, conversation_id, outcome, created_at)
     VALUES (?, ?, ?, ?, 'dashboard', ?, ?, datetime('now', ?))`,
  ).run(id, AGENT, o.turn, o.tool, o.conversationId, o.outcome, `${o.offsetSeconds} seconds`);
  return id;
}

/** An ask picked up by a turn — the shape every arm below starts from. */
function claimedAsk(messageId: string, turn: number, over: Record<string, unknown> = {}): string {
  insertMessage(ownerInbound({ id: messageId, ...over }) as never);
  claimAsk(askIdForMessage(messageId), AGENT);
  stampClaimingTurn(askIdForMessage(messageId), turn);
  return askIdForMessage(messageId);
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
    `INSERT INTO conversations (id, agent_id, channel, counterparty_id)
     VALUES ('conv-1', ?, 'dashboard', 'owner'), ('conv-2', ?, 'imessage', '+15550000')`,
  ).run(AGENT, AGENT);
});

// ════════════════════════════════════════════════════════════════════════
// ARM 1 — CLOSE WITH THE RECEIPT
// ════════════════════════════════════════════════════════════════════════

describe('ARM 1 — an ask closes against the delivery that answered it', () => {
  it('POSITIVE: a delivered reply to the ask own conversation closes it, pointing at the delivery', () => {
    claimedAsk('m-1', 4);
    seedDelivery('d-1');
    const r = settleAsk(askIdForMessage('m-1'), { agentId: AGENT, turnNumber: 4, at: 'delivery' });
    expect(r.verdict).toBe('closed');
    expect(r.deliveryId).toBe('d-1');
    const w = workFor('m-1');
    expect(w.state).toBe('done');
    expect(w.result_delivery_id).toBe('d-1');
    expect(w.closed_at).not.toBeNull();
    expect(transitionsFor('m-1').at(-1)!.reason).toBe('delivered via auto-route');
  });

  it('the settlement WRITES THE SERVED STAMP — the fact the batch-claim used to write', () => {
    // The stamp is not a second mechanism: it is part of the settlement, so the record that
    // says "this turn answered this row" and the record that says "this ask is closed" can
    // never disagree. `setAnswerMessageId` at turn finalize keys on exactly this column.
    claimedAsk('m-1', 4);
    seedDelivery('d-1');
    const rowid = messageFor('m-1').rowid as number;
    settleAsk(askIdForMessage('m-1'), { agentId: AGENT, turnNumber: 4, at: 'delivery', rowid });
    expect(messageFor('m-1').served_by_turn).toBe(4);
  });

  it('an already-terminal ask is never touched twice', () => {
    claimedAsk('m-1', 4);
    seedDelivery('d-1');
    expect(settleAsk(askIdForMessage('m-1'), { agentId: AGENT, turnNumber: 4, at: 'delivery' }).verdict).toBe('closed');
    const again = settleAsk(askIdForMessage('m-1'), { agentId: AGENT, turnNumber: 4, at: 'finalize' });
    expect(again.verdict).toBe('unchanged');
    expect(transitionsFor('m-1').filter((t) => t.to === 'done')).toHaveLength(1);
  });
});

// ════════════════════════════════════════════════════════════════════════
// ARM 2 — HOLD ON AN UNRESOLVED JOIN (bug 2's half of the predicate)
// ════════════════════════════════════════════════════════════════════════

describe('ARM 2 — an ask with delegated work outstanding is HELD, never closed', () => {
  it('remaining_children > 0: the ask goes to `blocked` with its reason, not to `done`', () => {
    claimedAsk('m-1', 4);
    openDelegationJoin({
      agentId: AGENT, parentWorkId: askIdForMessage('m-1'),
      threads: [{ threadId: 'th-1', assigneeAgent: 'peer' }],
      replyConversationId: CONV, ttlAt: Date.now() + 600_000,
    });
    seedDelivery('d-1');
    const r = settleAsk(askIdForMessage('m-1'), { agentId: AGENT, turnNumber: 4, at: 'delivery' });
    expect(r.verdict).toBe('held');
    const w = workFor('m-1');
    // At the pre-change tree this row read `done` with `remaining_children = 1`.
    expect(w.state).toBe('blocked');
    expect(w.remaining_children).toBe(1);
    expect(w.result_delivery_id).toBeNull();
    const last = transitionsFor('m-1').at(-1)!;
    expect(last.to).toBe('blocked');
    expect(last.reason, 'the hold states what it is waiting for').toMatch(/delegated|child/i);
  });

  it('compile_pending = 1 with the countdown at zero also holds — the compile has not landed', () => {
    claimedAsk('m-1', 4);
    mockDb.current!.prepare(
      'UPDATE work SET remaining_children = 0, compile_pending = 1 WHERE id = ?',
    ).run(askIdForMessage('m-1'));
    seedDelivery('d-1');
    expect(settleAsk(askIdForMessage('m-1'), { agentId: AGENT, turnNumber: 4, at: 'finalize' }).verdict).toBe('held');
    expect(workFor('m-1').state).toBe('blocked');
  });

  it('a held ask stays held rather than being re-held on every adjudication', () => {
    claimedAsk('m-1', 4);
    openDelegationJoin({
      agentId: AGENT, parentWorkId: askIdForMessage('m-1'),
      threads: [{ threadId: 'th-1', assigneeAgent: 'peer' }],
      replyConversationId: CONV, ttlAt: Date.now() + 600_000,
    });
    settleAsk(askIdForMessage('m-1'), { agentId: AGENT, turnNumber: 4, at: 'finalize' });
    settleAsk(askIdForMessage('m-1'), { agentId: AGENT, turnNumber: 4, at: 'finalize' });
    expect(transitionsFor('m-1').filter((t) => t.to === 'blocked')).toHaveLength(1);
  });

  it('NEGATIVE CONTROL: the same ask with NO join closes on the same delivery', () => {
    claimedAsk('m-1', 4);
    seedDelivery('d-1');
    expect(settleAsk(askIdForMessage('m-1'), { agentId: AGENT, turnNumber: 4, at: 'delivery' }).verdict).toBe('closed');
  });
});

// ════════════════════════════════════════════════════════════════════════
// ARM 3 — NO QUALIFYING DELIVERY: THE ASK GOES BACK, VISIBLE
// ════════════════════════════════════════════════════════════════════════

describe('ARM 3 — a turn that finalizes without answering hands the ask back', () => {
  it('the claim is returned to `open`, never left `claimed` past its turn finalize', () => {
    claimedAsk('m-1', 4);
    const r = settleAsk(askIdForMessage('m-1'), { agentId: AGENT, turnNumber: 4, at: 'finalize' });
    expect(r.verdict).toBe('reopened');
    const w = workFor('m-1');
    expect(w.state).toBe('open');
    expect(w.claimed_by_turn).toBeNull();
    expect(transitionsFor('m-1').at(-1)!.reason).toMatch(/re-opened/i);
  });

  it('MID-TURN the claim is left alone — a delivery arm never re-opens a live turn ask', () => {
    // The tie-break direction is "serve again", not "thrash": at the delivery moment the turn
    // may still be about to answer, so the absence of evidence means nothing yet.
    claimedAsk('m-1', 4);
    const r = settleAsk(askIdForMessage('m-1'), { agentId: AGENT, turnNumber: 4, at: 'delivery' });
    expect(r.verdict).toBe('unchanged');
    expect(workFor('m-1').state).toBe('claimed');
  });

  it('an ask that is already open is not re-opened again (no event churn)', () => {
    insertMessage(ownerInbound({ id: 'm-1' }) as never);
    const r = settleAsk(askIdForMessage('m-1'), { agentId: AGENT, turnNumber: 4, at: 'finalize' });
    expect(r.verdict).toBe('unchanged');
    expect(transitionsFor('m-1')).toHaveLength(0);
  });
});

// ════════════════════════════════════════════════════════════════════════
// ARM 4 — THE DELIVERY MUST POSTDATE THE ASK'S ARRIVAL
// ════════════════════════════════════════════════════════════════════════

describe('ARM 4 — a delivery recorded BEFORE the ask arrived is not its answer', () => {
  it('the older delivery is refused, and the ask is handed back instead of closed', () => {
    // The verification probe's own negative shape: the turn delivered, and only afterwards
    // did the sibling exist. At HEAD that delivery closed the ask (measured: 120s older).
    seedDelivery('d-old', { turn: 7, offsetSeconds: -120 });
    claimedAsk('m-late', 7);
    const r = settleAsk(askIdForMessage('m-late'), { agentId: AGENT, turnNumber: 7, at: 'finalize' });
    expect(r.verdict).toBe('reopened');
    expect(workFor('m-late').state).toBe('open');
  });

  it('NEGATIVE CONTROL: the same delivery moved to AFTER the arrival does close it', () => {
    claimedAsk('m-late', 7);
    seedDelivery('d-new', { turn: 7, offsetSeconds: +120 });
    const r = settleAsk(askIdForMessage('m-late'), { agentId: AGENT, turnNumber: 7, at: 'finalize' });
    expect(r.verdict).toBe('closed');
    expect(r.deliveryId).toBe('d-new');
  });
});

// ════════════════════════════════════════════════════════════════════════
// ARM 5 — THE `engine-ack` EXCLUSION, PRESERVED VERBATIM
// ════════════════════════════════════════════════════════════════════════

describe('ARM 5 — a start-ack is not an answer', () => {
  it('an `engine-ack` delivery is not evidence, whichever moment asks', () => {
    claimedAsk('m-1', 4);
    seedDelivery('d-ack', { tool: 'engine-ack' });
    expect(settleAsk(askIdForMessage('m-1'), { agentId: AGENT, turnNumber: 4, at: 'delivery' }).verdict)
      .toBe('unchanged');
    expect(workFor('m-1').state).toBe('claimed');
    expect(settleAsk(askIdForMessage('m-1'), { agentId: AGENT, turnNumber: 4, at: 'finalize' }).verdict)
      .toBe('reopened');
  });

  it('NEGATIVE CONTROL: the same row with the tool corrected closes the ask', () => {
    claimedAsk('m-1', 4);
    seedDelivery('d-real', { tool: 'auto-route' });
    expect(settleAsk(askIdForMessage('m-1'), { agentId: AGENT, turnNumber: 4, at: 'delivery' }).verdict).toBe('closed');
  });
});

// ════════════════════════════════════════════════════════════════════════
// INVOCATION (a) — AT EACH DELIVERY, INSIDE THE DELIVERY TRANSACTION
// The three narrowings `closeAsksForDelivery` carried, each still a negative control.
// ════════════════════════════════════════════════════════════════════════

describe('invocation (a): the delivery arm', () => {
  beforeEach(() => { claimedAsk('m-1', 4); });

  it('closes the asks this turn holds when the delivery answers them', () => {
    seedDelivery('d-1');
    expect(settleAsksForDelivery({
      agentId: AGENT, turnNumber: 4, deliveryId: 'd-1',
      conversationId: CONV, tool: 'auto-route', outcome: 'delivered',
    })).toBe(1);
    expect(workFor('m-1').state).toBe('done');
  });

  it('NEGATIVE CONTROLS: only a DELIVERED answer, to THIS conversation, from THIS turn', () => {
    const stays = (why: string): void => { expect(workFor('m-1').state, why).toBe('claimed'); };
    // ...a send that did not land
    for (const outcome of ['held', 'failed', 'suppressed'] as const) {
      seedDelivery(`d-${outcome}`, { outcome });
      expect(settleAsksForDelivery({
        agentId: AGENT, turnNumber: 4, deliveryId: `d-${outcome}`,
        conversationId: CONV, tool: 'auto-route', outcome,
      })).toBe(0);
      stays(`outcome=${outcome} must not close the ask`);
    }
    // ...a start-ack
    seedDelivery('d-ack', { tool: 'engine-ack' });
    expect(settleAsksForDelivery({
      agentId: AGENT, turnNumber: 4, deliveryId: 'd-ack',
      conversationId: CONV, tool: 'engine-ack', outcome: 'delivered',
    })).toBe(0);
    stays('an engine start-ack must not close the ask');
    // ...an email to a THIRD PARTY sent while working on the owner's question
    seedDelivery('d-other', { conversationId: 'conv-2', tool: 'gmail_send' });
    expect(settleAsksForDelivery({
      agentId: AGENT, turnNumber: 4, deliveryId: 'd-other',
      conversationId: 'conv-2', tool: 'gmail_send', outcome: 'delivered',
    })).toBe(0);
    stays('a delivery to another conversation must not close the ask');
    // ...another turn's delivery
    seedDelivery('d-99', { turn: 99 });
    expect(settleAsksForDelivery({
      agentId: AGENT, turnNumber: 99, deliveryId: 'd-99',
      conversationId: CONV, tool: 'auto-route', outcome: 'delivered',
    })).toBe(0);
    stays('a different turn\'s delivery must not close the ask');
    // ...and the same call with the one offending detail corrected DOES close it.
    seedDelivery('d-ok');
    expect(settleAsksForDelivery({
      agentId: AGENT, turnNumber: 4, deliveryId: 'd-ok',
      conversationId: CONV, tool: 'auto-route', outcome: 'delivered',
    })).toBe(1);
    expect(workFor('m-1').state).toBe('done');
  });
});

// ════════════════════════════════════════════════════════════════════════
// INVOCATION (b) — TURN FINALIZE, THE FINAL ADJUDICATOR
// ════════════════════════════════════════════════════════════════════════

describe('invocation (b): the turn-finalize adjudicator', () => {
  it('THE FOSSIL SHAPE: the sibling answered inside the turn closes on the turn own delivery', () => {
    // The exact recorded defect: the turn delivers, its own claim closes at send time, and
    // the sibling that was inside the same assembled context is claimed AFTERWARDS by a turn
    // that then finalizes — at HEAD it stayed `claimed` for ever.
    claimedAsk('m-1', 4);
    insertMessage(ownerInbound({ id: 'm-2', content: 'and the gutters?' }) as never);
    seedDelivery('d-1');
    const sibling = { workId: askIdForMessage('m-2'), rowid: messageFor('m-2').rowid as number };
    const r = settleAsksAtTurnFinalize({ agentId: AGENT, turnNumber: 4, assembled: [sibling] });
    expect(r.closed).toBe(2);
    expect(workFor('m-1').state).toBe('done');
    expect(workFor('m-2').state).toBe('done');
    expect(workFor('m-2').result_delivery_id).toBe('d-1');
    expect(messageFor('m-2').served_by_turn).toBe(4);
  });

  it('THE STRUCTURAL INVARIANT: no ask is left `claimed` by a finalized turn', () => {
    claimedAsk('m-1', 4);              // the turn answers nothing at all
    settleAsksAtTurnFinalize({ agentId: AGENT, turnNumber: 4 });
    const survivors = mockDb.current!.prepare(
      `SELECT count(*) AS c FROM work WHERE kind = 'ask' AND state = 'claimed' AND claimed_by_turn = 4`,
    ).get() as { c: number };
    expect(survivors.c).toBe(0);
    expect(workFor('m-1').state).toBe('open');
  });

  it('THE B3 SHAPE: an ask answered inside a turn that never claimed it is settled too', () => {
    // The probe's third closer — the model reaching for `work_close_request` because the row
    // was in front of it in OPEN WORK. The authority reaches the same row structurally: it
    // entered the turn's context, and the turn's delivery answers it.
    insertMessage(ownerInbound({ id: 'm-b3', content: 'and the downpipes?' }) as never);
    expect(workFor('m-b3').state).toBe('open');
    expect(workFor('m-b3').claimed_by_turn).toBeNull();
    seedDelivery('d-1');
    const r = settleAsksAtTurnFinalize({
      agentId: AGENT, turnNumber: 4,
      assembled: [{ workId: askIdForMessage('m-b3'), rowid: messageFor('m-b3').rowid as number }],
    });
    expect(r.closed).toBe(1);
    expect(workFor('m-b3').state).toBe('done');
  });

  it('OPEN-12: a row that arrived AFTER the final assembly is not in the set and keeps its own turn', () => {
    insertMessage(ownerInbound({ id: 'm-in' }) as never);
    const assembledAt = new Date().toISOString();
    // …and one that lands after it
    mockDb.current!.prepare('UPDATE messages SET created_at = ? WHERE id = ?')
      .run(Date.now() + 60_000, 'm-in');
    insertMessage(ownerInbound({ id: 'm-late-arrival' }) as never);
    mockDb.current!.prepare('UPDATE messages SET created_at = ? WHERE id = ?')
      .run(Date.now() + 60_000, 'm-late-arrival');
    mockDb.current!.prepare('UPDATE work SET opened_at = ? WHERE id IN (?, ?)')
      .run(Date.now() + 60_000, askIdForMessage('m-in'), askIdForMessage('m-late-arrival'));
    const set = assembledContextAsks(AGENT, 'owner', assembledAt);
    expect(set.map((s) => s.workId)).not.toContain(askIdForMessage('m-late-arrival'));
    expect(set.map((s) => s.workId)).not.toContain(askIdForMessage('m-in'));
    expect(workFor('m-late-arrival').state).toBe('open');
  });

  it('the assembled-context read WRITES NOTHING — it reports the set, the authority decides', () => {
    insertMessage(ownerInbound({ id: 'm-1' }) as never);
    const before = mockDb.current!.prepare("SELECT count(*) AS c FROM work_events").get() as { c: number };
    const set = assembledContextAsks(AGENT, 'owner', new Date(Date.now() + 60_000).toISOString());
    expect(set.map((s) => s.workId)).toContain(askIdForMessage('m-1'));
    expect(workFor('m-1').state, 'the read must not claim anything').toBe('open');
    const after = mockDb.current!.prepare("SELECT count(*) AS c FROM work_events").get() as { c: number };
    expect(after.c).toBe(before.c);
  });

  it('a join opened by the delegating turn leaves the ask BLOCKED at finalize, never done', () => {
    claimedAsk('m-1', 4);
    openDelegationJoin({
      agentId: AGENT, parentWorkId: askIdForMessage('m-1'),
      threads: [{ threadId: 'th-1', assigneeAgent: 'peer' }],
      replyConversationId: CONV, ttlAt: Date.now() + 600_000,
    });
    seedDelivery('d-1');
    const r = settleAsksAtTurnFinalize({ agentId: AGENT, turnNumber: 4 });
    expect(r.held).toBe(1);
    expect(workFor('m-1').state).toBe('blocked');
  });
});

// ════════════════════════════════════════════════════════════════════════
// THE CRASH WINDOW — SWEEP-A TB3 Step 5.
//
// TB2's ordering arm hands back an ask that a turn closed and THEN delegated under. It runs
// at TURN FINALIZE, so a process killed between the delegation and the finalize leaves the
// row exactly as bug 2 left it: `done`, with an unresolved join, and every safety net
// downstream blind to it — "the nets did not fail, they were never given anything to catch".
//
// The boot reconciler already exists for precisely this class of leftover (a turn that died
// mid-lifecycle) and already carries the bound that stops it storming: the SAME thirty-minute
// window, and the same dead-turn predicate. This is that arm's scope widened by one shape,
// not a new mechanism and not a new bound.
//
// WHY IT CANNOT STORM, structurally rather than by hope:
//   * the window is 30 minutes on `updated_at` — a crash is seconds-to-minutes old;
//   * the serving turn must be DEAD (`turns.ended_at IS NULL`) — a turn that finalized was
//     already adjudicated by the finalize arm;
//   * a row is adjudicated ONCE: the hand-back moves it out of `done`, so the scope query
//     cannot see it again;
//   * and the ladder's own per-row lifetime bound (3 re-drives + 2 stuck notices) governs
//     everything that happens to the row afterwards. This arm adds no drive of its own.
// ════════════════════════════════════════════════════════════════════════

describe('the crash window: a `done` ask with an unresolved join whose turn never finished', () => {
  /** A turn that STARTED and never ended — the crash signature. */
  const deadTurn = (n: number): void => {
    mockDb.current!.prepare(
      `INSERT OR REPLACE INTO turns (agent_id, turn_number, started_at, ended_at, exit_reason, answered)
       VALUES (?, ?, datetime('now','-120 seconds'), NULL, NULL, 0)`,
    ).run(AGENT, n);
  };
  const finishedTurn = (n: number): void => {
    mockDb.current!.prepare(
      `INSERT OR REPLACE INTO turns (agent_id, turn_number, started_at, ended_at, exit_reason, answered)
       VALUES (?, ?, datetime('now','-120 seconds'), datetime('now','-60 seconds'), 'answered', 1)`,
    ).run(AGENT, n);
  };
  /** The shape the crash leaves: closed on this turn's own delivery, then delegated under. */
  const closedThenDelegated = (messageId: string, turn: number): string => {
    claimedAsk(messageId, turn);
    seedDelivery(`d-${messageId}`, { turn });
    const id = askIdForMessage(messageId);
    expect(settleAsk(id, { agentId: AGENT, turnNumber: turn, at: 'delivery' }).verdict).toBe('closed');
    openDelegationJoin({
      agentId: AGENT, parentWorkId: id,
      threads: [{ threadId: `th-${messageId}`, assigneeAgent: 'peer' }],
      replyConversationId: CONV, ttlAt: Date.now() + 600_000,
    });
    expect(workFor(messageId).state).toBe('done');
    return id;
  };

  it('POSITIVE: the boot reconciler hands it back and HOLDS it — the nets get something to catch', () => {
    closedThenDelegated('m-1', 4);
    deadTurn(4);
    const r = reconcileOrphanedClaims();
    expect(r.handedBack).toBe(1);
    expect(workFor('m-1').state).toBe('blocked');
    // The record is not falsified: the close is still in the log, followed by the undo.
    expect(transitionsFor('m-1').map((t) => t.to)).toEqual(['claimed', 'done', 'open', 'blocked']);
  });

  it('NEGATIVE CONTROL, one detail different — the turn FINALIZED: the finalize arm owned it, boot does not', () => {
    closedThenDelegated('m-1', 4);
    finishedTurn(4);
    const r = reconcileOrphanedClaims();
    expect(r.handedBack).toBe(0);
    expect(workFor('m-1').state).toBe('done');
  });

  it('NEGATIVE CONTROL, one detail different — no unresolved join: a closed ask stays closed', () => {
    claimedAsk('m-1', 4);
    seedDelivery('d-1', { turn: 4 });
    settleAsk(askIdForMessage('m-1'), { agentId: AGENT, turnNumber: 4, at: 'delivery' });
    deadTurn(4);
    const r = reconcileOrphanedClaims();
    expect(r.handedBack).toBe(0);
    expect(workFor('m-1').state).toBe('done');
  });

  it('THE WINDOW BOUNDS IT — a row last touched over 30 minutes ago is history, not a crash', () => {
    closedThenDelegated('m-1', 4);
    deadTurn(4);
    mockDb.current!.prepare('UPDATE work SET updated_at = ? WHERE id = ?')
      .run(Date.now() - 31 * 60 * 1000, askIdForMessage('m-1'));
    const r = reconcileOrphanedClaims();
    expect(r.handedBack).toBe(0);
    expect(workFor('m-1').state).toBe('done');
  });

  it('ADJUDICATED ONCE — a second boot over the same body moves nothing and writes nothing', () => {
    closedThenDelegated('m-1', 4);
    deadTurn(4);
    expect(reconcileOrphanedClaims().handedBack).toBe(1);
    const events = (mockDb.current!.prepare(
      'SELECT count(*) AS c FROM work_events WHERE work_id = ?',
    ).get(askIdForMessage('m-1')) as { c: number }).c;
    expect(reconcileOrphanedClaims().handedBack).toBe(0);
    expect((mockDb.current!.prepare(
      'SELECT count(*) AS c FROM work_events WHERE work_id = ?',
    ).get(askIdForMessage('m-1')) as { c: number }).c).toBe(events);
  });

  it('NO STORM at N=5 — five seeded crash rows are each adjudicated exactly once, in one pass', () => {
    for (let i = 1; i <= 5; i++) { closedThenDelegated(`m-${i}`, 10 + i); deadTurn(10 + i); }
    const r = reconcileOrphanedClaims();
    expect(r.handedBack).toBe(5);
    for (let i = 1; i <= 5; i++) expect(workFor(`m-${i}`).state).toBe('blocked');
    // and the second pass is a no-op — bounded, not repeated
    expect(reconcileOrphanedClaims().handedBack).toBe(0);
  });
});

// ════════════════════════════════════════════════════════════════════════
// ARM 6 — THE RECEIPT MUST BE THE TURN'S ANSWER (SWEEP CORE-1, CT0)
//
// WHAT WAS MEASURED, so "RED" is a number rather than a claim. Three investigate-shaped
// asks were driven through the real door (`POST /api/chat/kevin/messages`) at the SHIPPED
// build `587693e` on 2026-08-09, and all three were marked `done` on the model's OPENING
// START-ACK — seconds after the question arrived and tens of seconds before the answer
// existed:
//
//   ask:d8cf8457  done 09:36:02 (+9 s)  receipt -> "On it — checking the folder now."
//                                        answer  09:36:09  "16 .ts files … store.ts at 1,667 lines"
//   ask:1f5911cc  done 09:38:39 (+4 s)  receipt -> "On it — checking each part separately."
//                                        answer  09:39:16  "All four parts checked. Here's the summary…"
//   ask:ed356166  done 09:41:26 (+4 s)  receipt -> "On it — checking the folder now."
//                                        answer  09:41:41  "29 .ts files directly in that folder…"
//
// On all three `turns.answer_message_id` — the truthful-answer key, ONE setter — named the
// REAL answer while `work.result_delivery_id` named the ack. The platform already knew which
// message was the answer; the settlement pointed somewhere else. Box-wide at that instant:
// 2,632 `done` asks carry a dashboard receipt, 2,053 of which ARE the turn's answer key —
// 579 are not (324 on a turn that recorded a DIFFERENT answer, 255 on a turn that recorded
// no answer at all).
//
// The doctrine is not new and this arm does not widen it — `NON_ANSWERING_DELIVERY_TOOLS`
// ("A START-ACK IS NOT AN ANSWER") and `NON_ANSWERING_DISPLAY_KINDS` ("AND NEITHER IS A
// TOOL-CALL CHIP") are the same sentence about the `engine-ack` lane and about a chip. This
// is its third form: the model's own opening line, delivered under the ordinary door, while
// the turn is still working. It is corrected at the TURN BOUNDARY for the same reason TB2's
// ordering arm is: mid-turn the authority cannot know which bubble was the answer, and at
// the boundary the turn record says so.
//
// TB3's remediation pass already treated the identical two-armed shape for chip receipts
// (re-point when the same turn really answered, hand back when nothing ever did). It
// corrected the HISTORY; nothing stopped the class recurring. This is the forward behaviour.
// ════════════════════════════════════════════════════════════════════════

describe('ARM 6 — an ask is done on the turn ANSWER, never on its opening status line', () => {
  /** A user-visible assistant bubble, and the delivery that carried it out of the building. */
  const bubbleDelivery = (
    deliveryId: string, messageId: string, text: string,
    o: { turn?: number; offsetSeconds?: number; tool?: string; conversationId?: string | null } = {},
  ): void => {
    const t = { turn: 4, offsetSeconds: 0, tool: 'dashboard', conversationId: CONV, ...o };
    mockDb.current!.prepare(
      `INSERT INTO messages (id, agent_id, role, content, lane, display_kind, display_tier,
                             conversation_id, turn_number, created_at)
       VALUES (?, ?, 'assistant', ?, 'owner', 'agent-text', 'user-visible', ?, ?, ?)`,
    ).run(messageId, AGENT, text, t.conversationId, t.turn, Date.now() + t.offsetSeconds * 1000);
    mockDb.current!.prepare(
      `INSERT INTO deliveries (id, agent_id, turn_number, tool, channel, conversation_id,
                               message_id, outcome, created_at)
       VALUES (?, ?, ?, ?, 'dashboard', ?, ?, 'delivered', datetime('now', ?))`,
    ).run(deliveryId, AGENT, t.turn, t.tool, t.conversationId, messageId, `${t.offsetSeconds} seconds`);
  };
  /** The turn record as `finalizeTurn` writes it, BEFORE the settlement runs (finalize-record.ts). */
  const finalizedTurn = (n: number, answerMessageId: string | null): void => {
    mockDb.current!.prepare(
      `INSERT OR REPLACE INTO turns (agent_id, turn_number, started_at, ended_at, exit_reason,
                                     answered, answer_message_id)
       VALUES (?, ?, datetime('now','-60 seconds'), datetime('now'), ?, ?, ?)`,
    ).run(AGENT, n, answerMessageId ? 'answered' : 'no_reply_intended', answerMessageId ? 1 : 0, answerMessageId);
  };
  const receiptOf = (messageId: string): string | null =>
    workFor(messageId).result_delivery_id as string | null;
  const auditsFor = (messageId: string): Array<Record<string, unknown>> =>
    (mockDb.current!.prepare(
      `SELECT payload FROM work_events WHERE work_id = ? AND kind = 'audit' ORDER BY id`,
    ).all(askIdForMessage('' + messageId)) as Array<{ payload: string }>)
      .map((r) => JSON.parse(r.payload) as Record<string, unknown>);

  it("THE OWNER'S CASE — the ack closes it mid-turn, and the BOUNDARY re-points the receipt at the answer", () => {
    claimedAsk('m-1', 4);
    // +0 s: "On it — checking the folder now." leaves the building. It is the only delivery
    // in existence, so the delivery arm closes the ask on it. That much is TB1's design.
    bubbleDelivery('d-ack', 'msg-ack', 'On it — checking the folder now.', { turn: 4 });
    expect(settleAsk(askIdForMessage('m-1'), { agentId: AGENT, turnNumber: 4, at: 'delivery' }).verdict)
      .toBe('closed');
    expect(receiptOf('m-1')).toBe('d-ack');
    // +7 s: the real answer.
    bubbleDelivery('d-ans', 'msg-ans', '16 .ts files. The largest is store.ts at 1,667 lines.',
      { turn: 4, offsetSeconds: 7 });
    finalizedTurn(4, 'msg-ans');
    settleAsksAtTurnFinalize({ agentId: AGENT, turnNumber: 4 });
    // The ask really was answered, so it stays done — and the record now names the answer.
    expect(workFor('m-1').state).toBe('done');
    expect(receiptOf('m-1')).toBe('d-ans');
    const audit = auditsFor('m-1').at(-1)!;
    expect(audit.marker).toBe('ct0_receipt_repointed');
    expect(audit.from_delivery_id).toBe('d-ack');
    expect(audit.to_delivery_id).toBe('d-ans');
    expect(String(audit.reason)).toContain('start-ack');
  });

  it('THE ACK-ONLY TURN — nothing answered the person, so the ask is OWED again with a NAMED cause', () => {
    claimedAsk('m-1', 4);
    bubbleDelivery('d-ack', 'msg-ack', 'On it — I will look into that now.', { turn: 4 });
    expect(settleAsk(askIdForMessage('m-1'), { agentId: AGENT, turnNumber: 4, at: 'delivery' }).verdict)
      .toBe('closed');
    finalizedTurn(4, null);                       // the turn ended having said only that
    settleAsksAtTurnFinalize({ agentId: AGENT, turnNumber: 4 });
    expect(workFor('m-1').state).toBe('open');
    expect(receiptOf('m-1')).toBeNull();          // a row handed back is settled on nothing
    const last = transitionsFor('m-1').at(-1)!;
    expect(last.to).toBe('open');
    expect(last.reason).toContain('start-ack');
    expect(last.reason.length).toBeGreaterThan(40);   // a NAMED cause, not a shrug
    // The record is not falsified: the close stays in the log, followed by the undo.
    expect(transitionsFor('m-1').map((t) => t.to)).toEqual(['claimed', 'done', 'open']);
  });

  it('NEGATIVE CONTROL — a turn whose ONE bubble IS the answer is not touched at all', () => {
    claimedAsk('m-1', 4);
    bubbleDelivery('d-ans', 'msg-ans', 'Sixteen. store.ts is the biggest.', { turn: 4 });
    settleAsk(askIdForMessage('m-1'), { agentId: AGENT, turnNumber: 4, at: 'delivery' });
    finalizedTurn(4, 'msg-ans');
    const before = (mockDb.current!.prepare('SELECT count(*) AS c FROM work_events WHERE work_id = ?')
      .get(askIdForMessage('m-1')) as { c: number }).c;
    settleAsksAtTurnFinalize({ agentId: AGENT, turnNumber: 4 });
    expect(workFor('m-1').state).toBe('done');
    expect(receiptOf('m-1')).toBe('d-ans');
    expect((mockDb.current!.prepare('SELECT count(*) AS c FROM work_events WHERE work_id = ?')
      .get(askIdForMessage('m-1')) as { c: number }).c).toBe(before);
  });

  it('NEGATIVE CONTROL — a CHANNEL send carries no bubble, so the bubble rule cannot reach it', () => {
    // Keyed on the delivery's OWN message row, exactly as the chip narrowing is: an email or
    // iMessage send records no message id and is untouched even when the turn's answer key
    // names some other row.
    claimedAsk('m-1', 4);
    seedDelivery('d-email', { turn: 4, tool: 'send_email' });          // no message_id
    settleAsk(askIdForMessage('m-1'), { agentId: AGENT, turnNumber: 4, at: 'delivery' });
    expect(receiptOf('m-1')).toBe('d-email');
    bubbleDelivery('d-note', 'msg-note', 'Sent.', { turn: 4, offsetSeconds: 5 });
    finalizedTurn(4, 'msg-note');
    settleAsksAtTurnFinalize({ agentId: AGENT, turnNumber: 4 });
    expect(workFor('m-1').state).toBe('done');
    expect(receiptOf('m-1')).toBe('d-email');
  });

  it("NEGATIVE CONTROL — the ENGINE'S join relay is not a model bubble and is untouched", () => {
    claimedAsk('m-1', 4);
    seedDelivery('d-relay', { turn: 4, tool: 'a2a-join-relay' });
    settleAsk(askIdForMessage('m-1'), { agentId: AGENT, turnNumber: 4, at: 'delivery' });
    bubbleDelivery('d-later', 'msg-later', 'Anything else?', { turn: 4, offsetSeconds: 5 });
    finalizedTurn(4, 'msg-later');
    settleAsksAtTurnFinalize({ agentId: AGENT, turnNumber: 4 });
    expect(workFor('m-1').state).toBe('done');
    expect(receiptOf('m-1')).toBe('d-relay');
  });

  it("NEGATIVE CONTROL — another turn's settled ask is not re-adjudicated by this turn's boundary", () => {
    claimedAsk('m-1', 3);
    bubbleDelivery('d-ack3', 'msg-ack3', 'On it.', { turn: 3 });
    settleAsk(askIdForMessage('m-1'), { agentId: AGENT, turnNumber: 3, at: 'delivery' });
    finalizedTurn(3, null);
    finalizedTurn(4, null);
    settleAsksAtTurnFinalize({ agentId: AGENT, turnNumber: 4 });   // a DIFFERENT turn finalizes
    expect(workFor('m-1').state).toBe('done');
    expect(receiptOf('m-1')).toBe('d-ack3');
  });

  it('ADJUDICATED ONCE — a second finalize over the same turn moves nothing and writes nothing', () => {
    claimedAsk('m-1', 4);
    bubbleDelivery('d-ack', 'msg-ack', 'On it — checking now.', { turn: 4 });
    settleAsk(askIdForMessage('m-1'), { agentId: AGENT, turnNumber: 4, at: 'delivery' });
    bubbleDelivery('d-ans', 'msg-ans', 'Sixteen files; store.ts is biggest.', { turn: 4, offsetSeconds: 7 });
    finalizedTurn(4, 'msg-ans');
    settleAsksAtTurnFinalize({ agentId: AGENT, turnNumber: 4 });
    const events = (mockDb.current!.prepare('SELECT count(*) AS c FROM work_events WHERE work_id = ?')
      .get(askIdForMessage('m-1')) as { c: number }).c;
    settleAsksAtTurnFinalize({ agentId: AGENT, turnNumber: 4 });
    expect(receiptOf('m-1')).toBe('d-ans');
    expect((mockDb.current!.prepare('SELECT count(*) AS c FROM work_events WHERE work_id = ?')
      .get(askIdForMessage('m-1')) as { c: number }).c).toBe(events);
  });
});

// ════════════════════════════════════════════════════════════════════════
// ARM 7 — THE RE-SERVE HAS A BOUND OF ITS OWN (SWEEP CORE-1 CT0, closing TB3 §8.3)
//
// TB3 §8.3: *"the settlement authority's no-evidence arm has NO BOUND OF ITS OWN: it will
// hand an ask back forever, and the only thing between that and a spin is a counter owned by
// a different subsystem for a different reason."* Measured on the live body at the shipped
// build: `ask:3bba2728` handed back on turns 452, 457, 458, 459, 460 and 461 — six serves in
// three minutes, every turn exiting `no_reply_intended` — and `ask:ec6392a5` on 4285 and 4286
// with a third serve on 4287, 45 seconds end to end.
// ════════════════════════════════════════════════════════════════════════

describe('ARM 7 — an ask is not served into the same silence for ever', () => {
  const finalizeWithNothing = (messageId: string, turn: number): string =>
    settleAsk(askIdForMessage(messageId), { agentId: AGENT, turnNumber: turn, at: 'finalize' }).verdict;
  const reclaim = (messageId: string, turn: number): void => {
    claimAsk(askIdForMessage(messageId), AGENT);
    stampClaimingTurn(askIdForMessage(messageId), turn);
  };

  it('the ladder spends its rungs, then STANDS DOWN — held OWED, never closed, never abandoned', () => {
    claimedAsk('m-1', 1);
    // Serves 1..MAX: each finalize with nothing delivered hands the ask back OPEN.
    for (let i = 0; i < MAX_ASK_RE_SERVES; i++) {
      expect(finalizeWithNothing('m-1', 1 + i)).toBe('reopened');
      expect(workFor('m-1').state).toBe('open');
      reclaim('m-1', 2 + i);
    }
    // The rung after the bound: the drain's queue is `state = 'open'`, so holding the row
    // `blocked` is what actually stops the spin — and `blocked` is an OWED state the OPEN
    // WORK surface renders, so the model keeps being reminded rather than the ask vanishing.
    expect(finalizeWithNothing('m-1', 1 + MAX_ASK_RE_SERVES)).toBe('held');
    const w = workFor('m-1');
    expect(w.state).toBe('blocked');
    expect(w.closed_at).toBeNull();                       // not closed
    expect(w.result_delivery_id).toBeNull();              // and settled on nothing
    const last = transitionsFor('m-1').at(-1)!;
    expect(last.to).toBe('blocked');
    expect(last.reason).toContain('re-serve stood down');
    expect(last.reason).toContain('NOT answered');
  });

  it('the count is on the RECORD, so a reader never has to add it up', () => {
    claimedAsk('m-1', 1);
    expect(finalizeWithNothing('m-1', 1)).toBe('reopened');
    expect(transitionsFor('m-1').at(-1)!.reason).toContain(`serve 2 of ${MAX_ASK_RE_SERVES + 1}`);
    const audits = mockDb.current!.prepare(
      `SELECT payload FROM work_events WHERE work_id = ? AND kind = 'audit' ORDER BY id`,
    ).all(askIdForMessage('m-1')) as Array<{ payload: string }>;
    expect(audits).toHaveLength(1);
    expect((JSON.parse(audits[0].payload) as { marker: string }).marker).toBe(RE_SERVE_MARKER);
  });

  it('NEGATIVE CONTROL — an ask that gets ANSWERED never reaches the bound', () => {
    claimedAsk('m-1', 1);
    for (let i = 0; i < MAX_ASK_RE_SERVES; i++) {
      expect(finalizeWithNothing('m-1', 1 + i)).toBe('reopened');
      reclaim('m-1', 2 + i);
    }
    seedDelivery('d-1', { turn: 1 + MAX_ASK_RE_SERVES });
    expect(settleAsk(askIdForMessage('m-1'), {
      agentId: AGENT, turnNumber: 1 + MAX_ASK_RE_SERVES, at: 'finalize',
    }).verdict).toBe('closed');
    expect(workFor('m-1').state).toBe('done');
  });

  it("NEGATIVE CONTROL — the ladder is PER ROW: one spent ask does not stand another one down", () => {
    claimedAsk('m-1', 1);
    for (let i = 0; i < MAX_ASK_RE_SERVES; i++) { finalizeWithNothing('m-1', 1 + i); reclaim('m-1', 2 + i); }
    expect(finalizeWithNothing('m-1', 1 + MAX_ASK_RE_SERVES)).toBe('held');
    claimedAsk('m-2', 50);
    expect(finalizeWithNothing('m-2', 50)).toBe('reopened');
    expect(workFor('m-2').state).toBe('open');
  });

  it('a held ask is not re-held on every later boundary — the stand-down is idempotent', () => {
    claimedAsk('m-1', 1);
    for (let i = 0; i < MAX_ASK_RE_SERVES; i++) { finalizeWithNothing('m-1', 1 + i); reclaim('m-1', 2 + i); }
    finalizeWithNothing('m-1', 1 + MAX_ASK_RE_SERVES);
    const events = (mockDb.current!.prepare('SELECT count(*) AS c FROM work_events WHERE work_id = ?')
      .get(askIdForMessage('m-1')) as { c: number }).c;
    expect(finalizeWithNothing('m-1', 99)).toBe('held');
    expect((mockDb.current!.prepare('SELECT count(*) AS c FROM work_events WHERE work_id = ?')
      .get(askIdForMessage('m-1')) as { c: number }).c).toBe(events);
  });
});
