// ════════════════════════════════════════════════════════════════════════════════════════
// HL4 STEP 2 — NON-DELIVERY IS A FACT THE PLATFORM RECORDS. HL3'S MIRROR.
//
// W27's census, finding 4: *"`abandoned` has no reader. `steer-queue.ts` records 'written,
// never delivered' and nothing reads it. HL3 gave every steer a durable row at INJECTION;
// non-delivery is still in-memory-only and dies with the turn state."*
//
// The queue has known the fact all along — `fired` minus `delivered` is exactly "written,
// never seen by the model", and the module's own header says so in as many words. What it
// never had was anywhere to say it. So the turn boundary says it, in the one place where
// the whole turn's queue is final, and in the SAME shape the T41 rider beside it already
// uses: one WARN line, plus a durable `audit` marker on the person's own ask when there is
// one. No new event kind, no new table, no schema change, and no second mechanism — the
// record is a READER of state the queue already keeps.
//
// THE BOUNDARY, NOT THE DROP SITE, AND THAT IS THE POINT. An entry leaves `pending`
// undelivered three ways: the delivery-attempt cap abandons it, a give-up rung's
// family-scoped clear abandons it, or the turn simply ends with it still waiting — and the
// THIRD is the largest class and the one no drop site can see. One reader at the boundary
// catches all three and tells them apart; three readers at the drop sites would catch two
// and be three copies of one sentence.
//
// RED at `a9dd822`: nothing anywhere reads it.
// ════════════════════════════════════════════════════════════════════════════════════════

import { describe, it, expect, beforeEach, vi } from 'vitest';
import Database from 'better-sqlite3';

const mockDb: { current: Database.Database | null } = { current: null };
const warns: Array<{ msg: string; data: Record<string, unknown> }> = [];

vi.mock('../../../../../db/connection.js', async () => {
  const os = await import('node:os');
  const p = await import('node:path');
  return {
    getDb: () => {
      if (!mockDb.current) throw new Error('test DB not initialized');
      return mockDb.current;
    },
    closeDb: vi.fn(),
    getDbPath: () => p.join(os.tmpdir(), 'dojo-hl4-nondelivery', 'dojo.db'),
  };
});

vi.mock('../../../../../logger.js', () => ({
  createLogger: () => ({
    debug: vi.fn(), info: vi.fn(), error: vi.fn(),
    warn: (msg: string, data: Record<string, unknown>) => { warns.push({ msg, data }); },
  }),
}));

import { runMigrations } from '../../../../../db/migrations.js';
import { finalizeTurnRecord } from '../finalize-record.js';
import { advance, initState, type AgentTurnState } from '../../../state.js';
import {
  clearSteerQueueFor, emptySteerQueue, enqueueSteer, markSteerAttempted, markSteerDelivered,
  nextSteer, type SteerQueue,
} from '../../../steer-queue.js';
import type { TeardownContext } from '../index.js';

const AGENT = 'kevin';
const CONV = 'conv-1';
const ASK = 'ask-hl4';
const TURN = 5200;

interface Bag { [k: string]: unknown }
const turnCtxFor = (over: Record<string, unknown> = {}): Bag => ({
  agentId: AGENT, root: undefined, servedWork: undefined, convKey: 'imessage:+1555',
  startAckSteerRequested: false, startAckSteerArmedThisTurn: false,
  engineStartAckDeliveredThisTurn: false, startAckSteersInjected: 0,
  anyToolStartedThisTurn: false,
  toolPhaseEndedBySpinBrake: false, turnInjectedTechniqueId: null,
  lastAssembledAtIso: null, assemblerOverheadTokens: 0,
  ...over,
});

function ctxFor(turnCtx: Bag, over: Partial<TeardownContext> = {}): TeardownContext {
  return {
    agentId: AGENT, turnCtx: turnCtx as never, turnNumber: TURN, db: mockDb.current!,
    chosenConvKey: 'imessage:+1555', chosenConversationId: CONV, lastAssembledAtIso: null,
    terminalAnswerRowId: null, triggerWorkId: ASK,
    toolPhaseEndedBySpinBrake: false, turnInjectedTechniqueId: null,
    counterparty: { kind: 'user', name: 'David', relation: 'owner', channel: 'imessage', senderId: '+1555', senderIsAgent: false } as never,
    isA2ATurn: false, isEngineTurn: false,
    turnStartedAt: new Date(Date.now() - 180_000).toISOString().slice(0, 19).replace('T', ' '),
    inboundChannel: 'imessage', inboundContext: null,
    reArmIfStrandedNoAnswer: vi.fn(), stopStatusHeartbeat: vi.fn(),
    ...over,
  } as unknown as TeardownContext;
}

const markers = (): Array<Record<string, unknown>> => (mockDb.current!.prepare(
  `SELECT payload FROM work_events WHERE work_id = ? AND kind = 'audit'`,
).all(ASK) as Array<{ payload: string }>)
  .map((r) => JSON.parse(r.payload) as Record<string, unknown>)
  .filter((p) => p.marker === 'steer_written_never_delivered');

const recordWarns = (): Array<{ msg: string; data: Record<string, unknown> }> =>
  warns.filter((w) => /never reached the model/.test(w.msg));

/** A turn's queue, built the way the loop builds one. */
function queueWith(build: (q: SteerQueue) => SteerQueue): AgentTurnState {
  const base = initState({ agentId: AGENT, maxToolLoops: 20, turnNumber: TURN } as Parameters<typeof initState>[0]);
  return advance(base, { steerQueue: build(emptySteerQueue()) });
}

beforeEach(() => {
  warns.length = 0;
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  mockDb.current = db;
  runMigrations();
  db.pragma('foreign_keys = ON');
  db.prepare(`INSERT INTO agents (id, name, status, session_started_at) VALUES (?, 'Kevin', 'idle', '1970-01-01')`).run(AGENT);
  db.prepare(`INSERT INTO conversations (id, agent_id, channel, counterparty_id) VALUES (?, ?, 'imessage', '+1555')`).run(CONV, AGENT);
  db.prepare(
    `INSERT INTO work (id, kind, agent_id, requester, root_kind, root_id, state, intent,
                       wakes, closes_thread, title, opened_at, updated_at)
     VALUES (?, 'ask', ?, 'owner', 'message', 'm-1', 'claimed', 'answer', 1, 0,
             'Did you text Michael?', ?, ?)`,
  ).run(ASK, AGENT, Date.now() - 180_000, Date.now());
  db.prepare(
    `INSERT INTO turns (agent_id, turn_number, kind, subject_kind, subject_id, root_kind, root_id,
                        source_message_id, conv_key, answered, effectful_calls, started_at)
     VALUES (?, ?, 'user', 'conv', ?, 'message', 'm-1', 'm-1', 'imessage:+1555', 0, 0, datetime('now'))`,
  ).run(AGENT, TURN, CONV);
});

describe('a steer written and never delivered says so at the boundary', () => {
  it('RED→GREEN: still PENDING when the turn ended — one warn line and one durable marker', async () => {
    // The largest class and the one no drop site can see: the turn simply ran out of
    // model calls while a steer was still waiting its turn at the one-per-call drain.
    const state = queueWith((q) =>
      enqueueSteer(q, { floor: 'hoarding-advisory', content: '[Engine hint] advice', atLoop: 3 }));

    await finalizeTurnRecord(state, ctxFor(turnCtxFor()));

    expect(recordWarns()).toHaveLength(1);
    expect(recordWarns()[0].data).toMatchObject({ agentId: AGENT, turnNumber: TURN, undelivered: 1 });
    expect(markers()).toHaveLength(1);
    expect(markers()[0]).toMatchObject({
      marker: 'steer_written_never_delivered', turn_number: TURN, undelivered: 1,
    });
    expect(markers()[0].steers).toEqual([
      { floor: 'hoarding-advisory', priority: 90, at_loop: 3, attempts: 0, how: 'pending-at-turn-end' },
    ]);
  });

  it('ABANDONED by the delivery-attempt cap is told APART from merely pending', async () => {
    // Three unconfirmed pushes and the entry is abandoned rather than left blocking the
    // queue. The record has to say which of the two happened, or "undelivered" is one word
    // for two different failures.
    const state = queueWith((q) => {
      let out = enqueueSteer(q, { floor: 'spinning', content: '[System: spinning]', atLoop: 2 });
      for (let i = 0; i < 3; i++) out = markSteerAttempted(out, nextSteer(out)!);
      return out;
    });

    await finalizeTurnRecord(state, ctxFor(turnCtxFor()));

    expect(markers()[0].steers).toEqual([
      { floor: 'spinning', priority: 43, at_loop: 2, attempts: 3, how: 'abandoned' },
    ]);
  });

  it('ABANDONED by a give-up rung is recorded too — the 2b drop is not invisible', async () => {
    const state = queueWith((q) => {
      const out = enqueueSteer(q, { floor: 'empty-response', content: '[System: empty]', atLoop: 4 });
      return clearSteerQueueFor(out, ['output-grind', 'empty-response']);
    });

    await finalizeTurnRecord(state, ctxFor(turnCtxFor()));

    expect(markers()[0].steers).toEqual([
      { floor: 'empty-response', priority: 40, at_loop: 4, attempts: 0, how: 'abandoned' },
    ]);
  });

  it('a MIXED turn records every undelivered entry and none of the delivered ones', async () => {
    const state = queueWith((q) => {
      let out = enqueueSteer(q, { floor: 'ungrounded-claim', content: 'guard', key: 'ob-1', atLoop: 1 });
      out = enqueueSteer(out, { floor: 'promise-floor', content: 'promise', atLoop: 2 });
      out = enqueueSteer(out, { floor: 'hoarding-advisory', content: 'advice', atLoop: 2 });
      // The truth guard went out; the other two never got a call.
      return markSteerDelivered(out, nextSteer(out)!);
    });

    await finalizeTurnRecord(state, ctxFor(turnCtxFor()));

    expect(markers()[0]).toMatchObject({ undelivered: 2 });
    expect((markers()[0].steers as Array<{ floor: string }>).map((s) => s.floor))
      .toEqual(['promise-floor', 'hoarding-advisory']);
  });
});

describe('CONTROLS: the record never fires on a turn that has nothing to report', () => {
  it('every steer delivered → no warn, no marker', async () => {
    const state = queueWith((q) => {
      const out = enqueueSteer(q, { floor: 'ungrounded-claim', content: 'guard', key: 'ob-1', atLoop: 1 });
      return markSteerDelivered(out, nextSteer(out)!);
    });

    await finalizeTurnRecord(state, ctxFor(turnCtxFor()));

    expect(recordWarns()).toEqual([]);
    expect(markers()).toEqual([]);
  });

  it('no steers at all → no warn, no marker (the ordinary turn writes nothing)', async () => {
    await finalizeTurnRecord(queueWith((q) => q), ctxFor(turnCtxFor()));
    expect(recordWarns()).toEqual([]);
    expect(markers()).toEqual([]);
  });

  it('no ask to hang a row on → the LOG LINE still lands, and no row is invented', async () => {
    // The T41 rider's own disposition, kept: a turn with no ask keeps the log alone.
    const state = queueWith((q) =>
      enqueueSteer(q, { floor: 'spinning', content: 'nudge', atLoop: 1 }));

    await finalizeTurnRecord(state, ctxFor(turnCtxFor(), { triggerWorkId: null }));

    expect(recordWarns()).toHaveLength(1);
    expect(markers()).toEqual([]);
  });
});
