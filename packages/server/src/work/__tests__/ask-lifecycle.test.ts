// PHASE-2 T3 Step 1 — every ask is a ticket, and a claim is a STATE.
//
// The four properties this task exists to make true, each proven with a negative control
// beside a positive control of the same shape (a guard that never bit is not a guard):
//
//   1. An inbound owner message creates `work(kind='ask', state='open')` in the SAME
//      TRANSACTION as the message INSERT. Atomicity is proven by making the ask insert
//      fail and observing the message is not there either — not by reading the code.
//   2. Turn pickup is a compare-and-swap `open -> claimed` carrying `claimed_by_turn`.
//      A second process losing the race gets `conflict`, which is the D-2 bail
//      (requirement preserved: cross-process race -> exactly one winner).
//   3. An abort with ZERO effectful calls reverts the claim to `open` — the ask returns
//      to the waiting set and is re-served.
//   4. An abort WITH effectful calls NEVER re-fires (P6b). `turns.effectful_calls` is the
//      counted input, and it is DURABLE mid-turn, because the crash case is the whole
//      point: a turn that died after sending an email has no chance to write its count at
//      the end.
//
// Plus the two consequences those four have: a quick ask closes when its delivery records,
// and an orphaned claim left by a killed process is re-armed at boot without duplicating
// an effect (crash test B's mechanical half).

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
    getDbPath: () => path.join(os.tmpdir(), 'dojo-work-ask-test', 'dojo.db'),
  };
});

import { runMigrations } from '../../db/migrations.js';
import {
  transition, askIdForMessage, claimAsk, stampClaimingTurn, revertAskClaimOnAbort,
  closeAsksForDelivery, reconcileOrphanedClaims, openAsk,
} from '../store.js';
import { insertMessage, insertMessageIfAbsent } from '../../memory/message-store.js';
import { getWaitingHumanConversations } from '../../agent/v2/counterparty.js';

const AGENT = 'kevin';

const workFor = (messageId: string): Record<string, unknown> | undefined =>
  mockDb.current!.prepare('SELECT * FROM work WHERE id = ?').get(askIdForMessage(messageId)) as
    Record<string, unknown> | undefined;
const messageRow = (id: string): Record<string, unknown> | undefined =>
  mockDb.current!.prepare('SELECT * FROM messages WHERE id = ?').get(id) as
    Record<string, unknown> | undefined;
const eventsFor = (workId: string): Array<{ kind: string; payload: string | null }> =>
  mockDb.current!.prepare('SELECT kind, payload FROM work_events WHERE work_id = ? ORDER BY id')
    .all(workId) as Array<{ kind: string; payload: string | null }>;

/** The shape every channel producer hands the single writer for a real person's message. */
const ownerInbound = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  agentId: AGENT, role: 'user', content: 'can you check the roof quote?',
  lane: 'owner', channel: 'dashboard', senderId: 'owner', authorized: true,
  conversationId: 'conv-1',
  inboundMeta: JSON.stringify({ channel: 'dashboard', relation: 'owner' }),
  ...over,
});

function seedTurn(turnNumber: number, over: Record<string, unknown> = {}): void {
  const row = {
    agent_id: AGENT, turn_number: turnNumber, kind: 'user', subject_kind: 'conv',
    subject_id: 'conv-1', root_kind: 'ask', root_id: 'm-1', source_message_id: 'm-1',
    conv_key: 'owner', started_at: new Date().toISOString(), ended_at: null,
    exit_reason: null, answered: 0, effectful_calls: 0, answer_message_id: null, lane: null,
    ...over,
  };
  const cols = Object.keys(row);
  mockDb.current!.prepare(
    `INSERT INTO turns (${cols.join(', ')}) VALUES (${cols.map((c) => '@' + c).join(', ')})`,
  ).run(row);
}

beforeEach(() => {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  mockDb.current = db;
  runMigrations();
  db.pragma('foreign_keys = ON');
  db.prepare(
    `INSERT INTO agents (id, name, status, session_started_at)
     VALUES (?, 'Kevin', 'idle', '1970-01-01')`,
  ).run(AGENT);
  db.prepare(
    `INSERT INTO conversations (id, agent_id, channel, counterparty_id)
     VALUES ('conv-1', ?, 'dashboard', 'owner'), ('conv-2', ?, 'imessage', '+15550000')`,
  ).run(AGENT, AGENT);
  // A stand-in delivery id for the close tests, which pass agent/turn/conversation as
  // ARGUMENTS and never read this row's own columns.
  // PHASE-2 T5: its turn_number moved 4 -> 1. It used to say "turn 4 delivered into conv-1",
  // and T5's boot reconciliation reads exactly that edge — so the fixture was silently
  // asserting that the crash tests' turn 4 had already answered the owner, which is the
  // opposite of what those tests set up. Nothing else in this file reads the column.
  db.prepare(
    `INSERT INTO deliveries (id, agent_id, turn_number, tool, channel, conversation_id, outcome)
     VALUES ('d-1', ?, 1, 'auto-route', 'dashboard', 'conv-1', 'delivered')`,
  ).run(AGENT);
});

// ════════════════════════════════════════════════════════════════════════
// 1. THE ASK IS BORN WITH THE MESSAGE
// ════════════════════════════════════════════════════════════════════════

describe('an inbound owner message creates work(kind=ask, state=open)', () => {
  it('POSITIVE: the ask exists, is open, and points back at the message that caused it', () => {
    const p = insertMessage(ownerInbound({ id: 'm-1' }) as never);
    const w = workFor('m-1');
    expect(w).toBeDefined();
    expect(w!.kind).toBe('ask');
    expect(w!.state).toBe('open');
    expect(w!.agent_id).toBe(AGENT);
    expect(w!.root_kind).toBe('ask');
    expect(w!.root_id).toBe('m-1');
    expect(w!.conversation_id).toBe('conv-1');
    expect(w!.requester).toBe('owner');
    expect(w!.claimed_by_turn).toBeNull();
    expect(w!.result_delivery_id).toBeNull();
    expect(w!.closed_at).toBeNull();
    // The obligation is dated by the MESSAGE, not by the clock at some later step —
    // every age cliff in this platform reads this column.
    expect(w!.opened_at).toBe(messageRow(p.id)!.created_at);
    expect(eventsFor(askIdForMessage('m-1')).map((e) => e.kind)).toContain('opened');
  });

  it('NEGATIVE CONTROLS: nothing that is not a person asking gets a ticket', () => {
    // ...an engine event (the events lane)
    insertMessage(ownerInbound({ id: 'm-eng', lane: 'events', originIntent: 'scheduler',
      content: '[SOURCE: Scheduler] run the weekly report' }) as never);
    // ...a peer agent's message
    insertMessage(ownerInbound({ id: 'm-a2a', lane: 'a2a', sourceAgentId: 'peer-1',
      a2aThreadId: 'th-1', channel: null }) as never);
    // ...the agent's own reply
    insertMessage(ownerInbound({ id: 'm-self', role: 'assistant', content: 'sure' }) as never);
    // ...a persisted system row
    insertMessage(ownerInbound({ id: 'm-sys', role: 'system', content: 'a note' }) as never);
    // ...an UNAUTHORIZED third party (a mailbox notification about someone else's inbox)
    insertMessage(ownerInbound({ id: 'm-3p', authorized: false, channel: 'email',
      senderId: 'stranger@example.com',
      inboundMeta: JSON.stringify({ channel: 'email', relation: 'third_party', authorized: false }) }) as never);
    for (const id of ['m-eng', 'm-a2a', 'm-self', 'm-sys', 'm-3p']) {
      expect(workFor(id), `${id} must not open an ask`).toBeUndefined();
      expect(messageRow(id), `${id} must still be stored`).toBeDefined();
    }
    // ...and the SAME call shape with the one offending detail corrected DOES open one.
    insertMessage(ownerInbound({ id: 'm-ok' }) as never);
    expect(workFor('m-ok')).toBeDefined();
  });

  it('the ask set is EXACTLY the waiting set: same rows, same order, oldest first (P4)', () => {
    insertMessage(ownerInbound({ id: 'm-a', content: 'first thing' }) as never);
    insertMessage(ownerInbound({ id: 'm-b', content: 'second thing' }) as never);
    insertMessage(ownerInbound({ id: 'm-c', conversationId: 'conv-2', channel: 'imessage',
      senderId: '+15550000', content: 'from the phone',
      inboundMeta: JSON.stringify({ channel: 'imessage', relation: 'owner' }) }) as never);
    const waiting = getWaitingHumanConversations(AGENT);
    // Two conversations; the dashboard one is oldest so it is head of the queue, and its
    // TRIGGER is its own oldest unanswered message — never the newest (OPEN-12 / P4).
    expect(waiting.length).toBe(2);
    expect(waiting[0].oldest.id).toBe('m-a');
    expect(waiting[0].latest.id).toBe('m-b');
    expect(waiting[1].oldest.id).toBe('m-c');
  });

  it('ATOMICITY, proven by failure: if the ask cannot be written, the message is not either', () => {
    // Occupy the ask id this message would take, so its INSERT throws inside the same
    // transaction as the message INSERT. Nothing is mocked; the collision is real.
    openAsk({
      agentId: AGENT, messageId: 'm-clash', conversationId: 'conv-1',
      requesterId: 'owner', openedAt: 1_700_000_000_000, title: 'squatter',
    });
    expect(() => insertMessage(ownerInbound({ id: 'm-clash' }) as never)).toThrow();
    expect(messageRow('m-clash'), 'the message must have rolled back with its ask').toBeUndefined();
  });

  it('the idempotent insert is idempotent for the ASK too — one message, one ticket', () => {
    expect(insertMessageIfAbsent(ownerInbound({ id: 'm-dup' }) as never)).not.toBeNull();
    expect(insertMessageIfAbsent(ownerInbound({ id: 'm-dup' }) as never)).toBeNull();
    const n = mockDb.current!.prepare("SELECT count(*) AS c FROM work WHERE kind = 'ask'")
      .get() as { c: number };
    expect(n.c).toBe(1);
  });
});

// ════════════════════════════════════════════════════════════════════════
// 2. PICKUP IS A COMPARE-AND-SWAP
// ════════════════════════════════════════════════════════════════════════

describe('turn pickup = CAS open -> claimed', () => {
  beforeEach(() => { insertMessage(ownerInbound({ id: 'm-1' }) as never); });

  it('the winner claims it and it leaves the waiting set', () => {
    const r = claimAsk(askIdForMessage('m-1'), AGENT);
    expect(r.kind).toBe('applied');
    expect(workFor('m-1')!.state).toBe('claimed');
    expect(getWaitingHumanConversations(AGENT)).toEqual([]);
  });

  it('the LOSER gets `conflict`, which is the D-2 bail — one winner, never two turns', () => {
    expect(claimAsk(askIdForMessage('m-1'), AGENT).kind).toBe('applied');
    const second = claimAsk(askIdForMessage('m-1'), AGENT);
    expect(second.kind).toBe('conflict');
    if (second.kind !== 'conflict') return;
    expect(second.expected).toBe('open');
    expect(second.actual).toBe('claimed');
  });

  it('the claiming turn is recorded on the row once the turn has its number', () => {
    claimAsk(askIdForMessage('m-1'), AGENT);
    expect(workFor('m-1')!.claimed_by_turn).toBeNull();     // allocated after the claim
    expect(stampClaimingTurn(askIdForMessage('m-1'), 9)).toBe(1);
    expect(workFor('m-1')!.claimed_by_turn).toBe(9);
    // ...and it never overwrites a claim that already named its turn.
    expect(stampClaimingTurn(askIdForMessage('m-1'), 10)).toBe(0);
    expect(workFor('m-1')!.claimed_by_turn).toBe(9);
  });
});

// ════════════════════════════════════════════════════════════════════════
// 3 + 4. ABORT: RE-ARM WHEN NOTHING HAPPENED, NEVER RE-FIRE WHEN IT DID (P6b)
// ════════════════════════════════════════════════════════════════════════

describe('abort semantics (P6b — the counted input is turns.effectful_calls)', () => {
  beforeEach(() => {
    insertMessage(ownerInbound({ id: 'm-1' }) as never);
    claimAsk(askIdForMessage('m-1'), AGENT);
    stampClaimingTurn(askIdForMessage('m-1'), 4);
  });

  it('ZERO effectful calls: the claim reverts and the ask is served again', () => {
    const r = revertAskClaimOnAbort(askIdForMessage('m-1'), 0, 'model call exhausted retries');
    expect(r?.kind).toBe('applied');
    expect(workFor('m-1')!.state).toBe('open');
    expect(workFor('m-1')!.claimed_by_turn).toBeNull();
    expect(getWaitingHumanConversations(AGENT).map((w) => w.oldest.id)).toEqual(['m-1']);
  });

  it('EFFECTFUL calls: the claim STANDS, and the refusal is recorded rather than silent', () => {
    const r = revertAskClaimOnAbort(askIdForMessage('m-1'), 2, 'aborted after sending an email');
    expect(r).toBeNull();
    expect(workFor('m-1')!.state).toBe('claimed');
    expect(getWaitingHumanConversations(AGENT)).toEqual([]);
    expect(eventsFor(askIdForMessage('m-1')).map((e) => e.kind)).toContain('rearm_refused');
  });
});

// ════════════════════════════════════════════════════════════════════════
// 5. A QUICK ASK CLOSES WHEN ITS DELIVERY RECORDS
// ════════════════════════════════════════════════════════════════════════

describe('quick asks auto-close on their delivery', () => {
  beforeEach(() => {
    insertMessage(ownerInbound({ id: 'm-1' }) as never);
    claimAsk(askIdForMessage('m-1'), AGENT);
    stampClaimingTurn(askIdForMessage('m-1'), 4);
  });

  it('a delivered reply to the ask own conversation closes it, pointing at the delivery', () => {
    expect(closeAsksForDelivery({
      agentId: AGENT, turnNumber: 4, deliveryId: 'd-1',
      conversationId: 'conv-1', tool: 'auto-route', outcome: 'delivered',
    })).toBe(1);
    const w = workFor('m-1')!;
    expect(w.state).toBe('done');
    expect(w.result_delivery_id).toBe('d-1');
    expect(w.closed_at).not.toBeNull();
  });

  it('NEGATIVE CONTROLS: only a delivered answer to THIS conversation closes it', () => {
    const stays = (why: string): void => {
      expect(workFor('m-1')!.state, why).toBe('claimed');
    };
    // a held/failed/suppressed outcome is not an answer
    for (const outcome of ['held', 'failed', 'suppressed'] as const) {
      expect(closeAsksForDelivery({ agentId: AGENT, turnNumber: 4, deliveryId: 'd-1',
        conversationId: 'conv-1', tool: 'auto-route', outcome })).toBe(0);
      stays(`outcome=${outcome} must not close the ask`);
    }
    // a START-ACK is not an answer (OR2-PROVISIONAL: the engine saying "on it")
    expect(closeAsksForDelivery({ agentId: AGENT, turnNumber: 4, deliveryId: 'd-1',
      conversationId: 'conv-1', tool: 'engine-ack', outcome: 'delivered' })).toBe(0);
    stays('an engine start-ack must not close the ask');
    // an email to a THIRD PARTY sent while working on the owner ask is not its answer
    expect(closeAsksForDelivery({ agentId: AGENT, turnNumber: 4, deliveryId: 'd-1',
      conversationId: 'conv-2', tool: 'gmail_send', outcome: 'delivered' })).toBe(0);
    stays('a delivery to another conversation must not close the ask');
    // another turn's delivery is not this turn's answer
    expect(closeAsksForDelivery({ agentId: AGENT, turnNumber: 99, deliveryId: 'd-1',
      conversationId: 'conv-1', tool: 'auto-route', outcome: 'delivered' })).toBe(0);
    stays('a different turn\'s delivery must not close the ask');
    // ...and the same call with the one offending detail corrected DOES close it.
    expect(closeAsksForDelivery({ agentId: AGENT, turnNumber: 4, deliveryId: 'd-1',
      conversationId: 'conv-1', tool: 'auto-route', outcome: 'delivered' })).toBe(1);
    expect(workFor('m-1')!.state).toBe('done');
  });

  it('a closed ask never appears on the project board — the board reads task and project', () => {
    closeAsksForDelivery({ agentId: AGENT, turnNumber: 4, deliveryId: 'd-1',
      conversationId: 'conv-1', tool: 'auto-route', outcome: 'delivered' });
    const board = mockDb.current!.prepare(
      "SELECT count(*) AS c FROM work WHERE kind IN ('task','project')",
    ).get() as { c: number };
    expect(board.c).toBe(0);
    // The second half of this clause used to count rows in `legacy_tasks` ("the ask never
    // enters the legacy board tables"). PHASE-2 T10's migration `141` dropped that table, so
    // the requirement is now true BY CONSTRUCTION and the honest assertion is that the table
    // is gone — checked here rather than deleted, because a reader arriving later is exactly
    // what this clause existed to catch.
    const legacyStillThere = (mockDb.current!.prepare(
      `SELECT count(*) AS c FROM sqlite_master WHERE type='table' AND name='legacy_tasks'`,
    ).get() as { c: number }).c;
    expect(legacyStillThere).toBe(0);
  });
});

// ════════════════════════════════════════════════════════════════════════
// 6. CRASH TEST B, MECHANICAL HALF — kill between claim and effect
// ════════════════════════════════════════════════════════════════════════

describe('orphaned claims after a kill (crash test B)', () => {
  it('a claim whose turn never ended and did nothing is re-armed', () => {
    insertMessage(ownerInbound({ id: 'm-1' }) as never);
    claimAsk(askIdForMessage('m-1'), AGENT);
    stampClaimingTurn(askIdForMessage('m-1'), 4);
    seedTurn(4);                                   // ended_at NULL, effectful_calls 0
    expect(reconcileOrphanedClaims().reArmed).toBe(1);
    expect(workFor('m-1')!.state).toBe('open');
  });

  it('a claim whose turn ALREADY DID SOMETHING is held — no duplicate effects', () => {
    insertMessage(ownerInbound({ id: 'm-1' }) as never);
    claimAsk(askIdForMessage('m-1'), AGENT);
    stampClaimingTurn(askIdForMessage('m-1'), 4);
    seedTurn(4, { effectful_calls: 1 });           // died AFTER a real side effect
    const r = reconcileOrphanedClaims();
    expect(r.reArmed).toBe(0);
    expect(r.held).toBe(1);
    expect(workFor('m-1')!.state).toBe('claimed');
  });

  it('PHASE-2 T5: a claim whose turn DELIVERED and was then killed is CLOSED, not re-served', () => {
    // The third outcome the delivery edge makes readable. Before T5 the dashboard path
    // recorded nothing, so this ask could only be re-armed (re-answering a question the
    // person already had answered) or held (stranded forever).
    insertMessage(ownerInbound({ id: 'm-1' }) as never);
    claimAsk(askIdForMessage('m-1'), AGENT);
    stampClaimingTurn(askIdForMessage('m-1'), 4);
    seedTurn(4);
    mockDb.current!.prepare(
      `INSERT INTO deliveries (id, agent_id, turn_number, tool, channel, conversation_id, outcome)
       VALUES ('d-answer', ?, 4, 'dashboard', 'dashboard', 'conv-1', 'delivered')`,
    ).run(AGENT);
    const r = reconcileOrphanedClaims();
    expect(r.closed).toBe(1);
    expect(r.reArmed).toBe(0);
    expect(workFor('m-1')!.state).toBe('done');
    expect(workFor('m-1')!.result_delivery_id).toBe('d-answer');
  });

  it('NEGATIVE CONTROLS: a FAILED send, an engine-ack, and another conversation never close it', () => {
    // Three asks, three claiming turns, three near-miss deliveries. Each fails the close for
    // its own reason: the send did not land, a start-ack is not an answer, and an outbound to
    // somebody else while working on this question is not this question's answer.
    const cases = [
      { msg: 'm-f', turn: 41, id: 'd-failed', tool: 'dashboard', conv: 'conv-1', outcome: 'failed' },
      { msg: 'm-a', turn: 42, id: 'd-ack', tool: 'engine-ack', conv: 'conv-1', outcome: 'delivered' },
      { msg: 'm-o', turn: 43, id: 'd-other', tool: 'dashboard', conv: 'conv-2', outcome: 'delivered' },
    ] as const;
    for (const c of cases) {
      insertMessage(ownerInbound({ id: c.msg }) as never);
      claimAsk(askIdForMessage(c.msg), AGENT);
      stampClaimingTurn(askIdForMessage(c.msg), c.turn);
      seedTurn(c.turn, { effectful_calls: 1 });
      mockDb.current!.prepare(
        `INSERT INTO deliveries (id, agent_id, turn_number, tool, channel, conversation_id, outcome)
         VALUES (?, ?, ?, ?, 'dashboard', ?, ?)`,
      ).run(c.id, AGENT, c.turn, c.tool, c.conv, c.outcome);
    }
    expect(reconcileOrphanedClaims().closed).toBe(0);
    for (const c of cases) expect(workFor(c.msg)!.state, `${c.id} must not close the ask`).toBe('claimed');
  });

  it('a claim whose turn ENDED normally is left alone (it was answered, not orphaned)', () => {
    insertMessage(ownerInbound({ id: 'm-1' }) as never);
    claimAsk(askIdForMessage('m-1'), AGENT);
    stampClaimingTurn(askIdForMessage('m-1'), 4);
    seedTurn(4, { ended_at: new Date().toISOString(), exit_reason: 'answered', answered: 1 });
    expect(reconcileOrphanedClaims().reArmed).toBe(0);
    expect(workFor('m-1')!.state).toBe('claimed');
  });

  it('an OLD orphan is left alone — a boot must never re-answer weeks of backlog', () => {
    insertMessage(ownerInbound({ id: 'm-1' }) as never);
    claimAsk(askIdForMessage('m-1'), AGENT);
    stampClaimingTurn(askIdForMessage('m-1'), 4);
    seedTurn(4);
    mockDb.current!.prepare('UPDATE work SET updated_at = ? WHERE id = ?')
      .run(Date.now() - 3 * 60 * 60 * 1000, askIdForMessage('m-1'));
    expect(reconcileOrphanedClaims().reArmed).toBe(0);
    expect(workFor('m-1')!.state).toBe('claimed');
  });
});

// ════════════════════════════════════════════════════════════════════════
// 7. THE GATES STILL BIND — an ask is a work row like any other
// ════════════════════════════════════════════════════════════════════════

describe('an ask obeys the spine it lives in', () => {
  it('an ask cannot reach done without a delivery to point at', () => {
    insertMessage(ownerInbound({ id: 'm-1' }) as never);
    claimAsk(askIdForMessage('m-1'), AGENT);
    const r = transition(askIdForMessage('m-1'), { to: 'done', by: 'agent', reason: 'said so' });
    expect(r.kind).toBe('rejected');
    if (r.kind !== 'rejected') return;
    expect(r.gate).toBe('done-requires-delivery');
    expect(workFor('m-1')!.state).toBe('claimed');
  });
});
