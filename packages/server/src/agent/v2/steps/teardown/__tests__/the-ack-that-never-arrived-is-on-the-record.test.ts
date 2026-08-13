// ════════════════════════════════════════════════════════════════════════════════════════
// UX-REPAIR T41 (the observability rider) — "THE PERSON WAITED AND HEARD NOTHING" IS A FACT
// THE PLATFORM RECORDS.
//
// W19's rider, in its own words: *"the mechanism cannot report its own failure. A turn ending
// with `startAckSteerRequested` set and `engineStartAckDeliveredThisTurn` false — the owner's
// incident exactly — writes no log line and no row. 'Threshold passed' and 'steer injected'
// are recorded; 'the person waited and heard nothing' is not, which is why this could only be
// diagnosed from his pasted transcript."*
//
// So the turn boundary writes it: a WARN line every time, and a durable `audit` marker on the
// person's own ask — the row they were waiting on — using the same marker shape
// `work/ask-settlement.ts` already uses for machine-readable engine observations. No new
// event kind, no new table, no schema change.
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
    getDbPath: () => p.join(os.tmpdir(), 'dojo-t41-rider-test', 'dojo.db'),
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
import { initState, type AgentTurnState } from '../../../state.js';
import type { TeardownContext } from '../index.js';

const AGENT = 'kevin';
const CONV = 'conv-1';
const ASK = 'ask-t41';
const TURN = 4805;

interface Bag { [k: string]: unknown }
const turnCtxFor = (over: Record<string, unknown> = {}): Bag => ({
  agentId: AGENT, root: undefined, servedWork: undefined, convKey: 'imessage:+1555',
  startAckSteerRequested: false, startAckSteerArmedThisTurn: false,
  engineStartAckDeliveredThisTurn: false, startAckSteersInjected: 0,
  // The incident's own shape: the turn was WORK. The F10 gate's condition, carried here.
  anyToolStartedThisTurn: true,
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
  .filter((p) => p.marker === 'start_ack_owed_undelivered');

const riderWarns = (): Array<{ msg: string; data: Record<string, unknown> }> =>
  warns.filter((w) => /owing this person an acknowledgment/.test(w.msg));

let state: AgentTurnState;
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
             'Did the T-Mobile internet go down?', ?, ?)`,
  ).run(ASK, AGENT, Date.now() - 180_000, Date.now());
  db.prepare(
    `INSERT INTO turns (agent_id, turn_number, kind, subject_kind, subject_id, root_kind, root_id,
                        source_message_id, conv_key, answered, effectful_calls, started_at)
     VALUES (?, ?, 'user', 'conv', ?, 'message', 'm-1', 'm-1', 'imessage:+1555', 0, 0, datetime('now'))`,
  ).run(AGENT, TURN, CONV);
  state = initState({ agentId: AGENT, maxToolLoops: 20, turnNumber: TURN } as Parameters<typeof initState>[0]);
});

describe('a turn that owed an acknowledgment and never gave one says so, at the boundary', () => {
  it('RED→GREEN: the threshold passed, nothing was delivered — one warn line and one durable marker', async () => {
    const turnCtx = turnCtxFor({ startAckSteerRequested: true });
    await finalizeTurnRecord(state, ctxFor(turnCtx));

    expect(riderWarns()).toHaveLength(1);
    expect(riderWarns()[0].data).toMatchObject({
      agentId: AGENT, turnNumber: TURN, owedVia: 'threshold-owed', channel: 'imessage',
      answered: false, askId: ASK,
    });
    expect(markers()).toHaveLength(1);
    expect(markers()[0]).toMatchObject({
      marker: 'start_ack_owed_undelivered', turn_number: TURN,
      owed_via: 'threshold-owed', channel: 'imessage', answered: false,
    });
  });

  it('a steer that WAS armed and still produced nothing is recorded, and names which half of the window it died in', async () => {
    const turnCtx = turnCtxFor({ startAckSteerArmedThisTurn: true, startAckSteersInjected: 2 });
    await finalizeTurnRecord(state, ctxFor(turnCtx));
    expect(markers()[0]).toMatchObject({ owed_via: 'steer-armed', steers_injected: 2 });
  });

  it('the record survives a turn that DID answer — the owner\'s incident had an answer and no ack', async () => {
    const turnCtx = turnCtxFor({ startAckSteerRequested: true });
    mockDb.current!.prepare(
      `INSERT INTO messages (id, agent_id, role, content, lane, conversation_id, turn_number)
       VALUES ('answer-1', ?, 'assistant', 'It is up.', 'owner', ?, ?)`,
    ).run(AGENT, CONV, TURN);
    await finalizeTurnRecord(state, ctxFor(turnCtx, { terminalAnswerRowId: 'answer-1' }));
    expect(markers()[0]).toMatchObject({ answered: true, exit_reason: 'answered' });
  });

  it('an engine turn with no ask behind it still gets the log line, and invents no row to hang it on', async () => {
    const turnCtx = turnCtxFor({ startAckSteerRequested: true });
    await finalizeTurnRecord(state, ctxFor(turnCtx, { triggerWorkId: null }));
    expect(riderWarns()).toHaveLength(1);
    expect(riderWarns()[0].data.askId).toBeNull();
    expect(markers()).toEqual([]);
  });
});

describe('and stays silent about turns that owed nothing or paid what they owed', () => {
  it('CONTROL — the ack was owed and DELIVERED: nothing is recorded', async () => {
    const turnCtx = turnCtxFor({ startAckSteerRequested: true, engineStartAckDeliveredThisTurn: true });
    await finalizeTurnRecord(state, ctxFor(turnCtx));
    expect(riderWarns()).toEqual([]);
    expect(markers()).toEqual([]);
  });

  it('CONTROL — an ordinary turn that was never owed an ack records nothing', async () => {
    const turnCtx = turnCtxFor();
    await finalizeTurnRecord(state, ctxFor(turnCtx));
    expect(riderWarns()).toEqual([]);
    expect(markers()).toEqual([]);
  });

  // FOUND BY DRIVING, 2026-08-13. T41's pre-call door arms the ack before anyone can know
  // whether the turn will use tools, so on a routed channel a plain "Hey dude!" — answered in
  // 3.0 s, nobody kept waiting — ended with the ack technically owed and undelivered and wrote
  // a row saying the person heard nothing. The record inherits the F10 gate's OWN condition
  // ("the ack exists for WORK, not conversation") rather than a new one.
  it('CONTROL — a CHAT-SHAPED turn records nothing: no tool ever started, so no ack was owed', async () => {
    const turnCtx = turnCtxFor({ startAckSteerArmedThisTurn: true, anyToolStartedThisTurn: false });
    await finalizeTurnRecord(state, ctxFor(turnCtx));
    expect(riderWarns()).toEqual([]);
    expect(markers()).toEqual([]);
  });

  it('CONTROL — the marker is written ONCE per turn, not once per flag', async () => {
    const turnCtx = turnCtxFor({ startAckSteerRequested: true, startAckSteerArmedThisTurn: true });
    await finalizeTurnRecord(state, ctxFor(turnCtx));
    expect(markers()).toHaveLength(1);
  });
});
