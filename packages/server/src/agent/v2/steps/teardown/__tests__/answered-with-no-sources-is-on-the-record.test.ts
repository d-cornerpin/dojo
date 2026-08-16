// ════════════════════════════════════════════════════════════════════════════════════════
// UX-REPAIR ROUND 13 / T61 (b) — "ANSWERED WITH NOTHING CONSULTED" IS A FACT THE PLATFORM
// RECORDS.
//
// ── THE INCIDENT (round-13 S1, catalog §8.1–8.6) ──
// A fresh owner ask — "how much elevation gain is Mount Si, and do I need a Discover Pass"
// — answered in 5.2 seconds with ZERO tool calls. Seven factual specifics went out
// (elevation, two distances, a pass requirement, a land manager, $30/year, $10/day). The
// recorder then asked whether a source existed anywhere on the box: `messages`, `summaries`,
// `vault_entries`, `briefings`, every uploaded file — 0 rows, 0 files, in either direction.
// The private reasoning hedged wider than the reply did, and the two prices appear in the
// reply and nowhere in the reasoning at all.
//
// T61(a) — the conduct sentence — is the weak surface, and the plan says so in its own
// words. THIS is the half that survives being ignored: the class becomes COUNTABLE. It
// steers nothing and blocks nothing; nothing about what the model receives or what the
// person gets changes. It is the W20/T41 observability rider's shape, one incident over.
//
// THE SIGNATURE IS STRUCTURAL AND EVERY CLAUSE IS A RECORD — classifying "this ask needed
// sources" from the ask's prose is the standing ban, so the engine counts shapes only:
// owner ask · claimed by THIS turn · zero tool rows · zero recall reads · answered.
// ════════════════════════════════════════════════════════════════════════════════════════

import { describe, it, expect, beforeEach, vi } from 'vitest';
import Database from 'better-sqlite3';

const mockDb: { current: Database.Database | null } = { current: null };
const infos: Array<{ msg: string; data: Record<string, unknown> }> = [];

vi.mock('../../../../../db/connection.js', async () => {
  const os = await import('node:os');
  const p = await import('node:path');
  return {
    getDb: () => {
      if (!mockDb.current) throw new Error('test DB not initialized');
      return mockDb.current;
    },
    closeDb: vi.fn(),
    getDbPath: () => p.join(os.tmpdir(), 'dojo-t61-marker-test', 'dojo.db'),
  };
});

vi.mock('../../../../../logger.js', () => ({
  createLogger: () => ({
    debug: vi.fn(), warn: vi.fn(), error: vi.fn(),
    info: (msg: string, data: Record<string, unknown>) => { infos.push({ msg, data }); },
  }),
}));

import { runMigrations } from '../../../../../db/migrations.js';
import { finalizeTurnRecord } from '../finalize-record.js';
import { initState, advance, type AgentTurnState } from '../../../state.js';
import type { TeardownContext } from '../index.js';

const AGENT = 'behaviorbot';
const CONV = 'conv-s1';
const ASK = 'ask:s1-mount-si';
const TURN = 4931;

interface Bag { [k: string]: unknown }
const turnCtxFor = (over: Record<string, unknown> = {}): Bag => ({
  agentId: AGENT, root: undefined, servedWork: undefined, convKey: 'dashboard:owner',
  startAckSteerRequested: false, startAckSteerArmedThisTurn: false,
  engineStartAckDeliveredThisTurn: false, startAckSteersInjected: 0,
  // The S1 shape: the turn ran ONE model call and no tools at all.
  anyToolStartedThisTurn: false,
  toolPhaseEndedBySpinBrake: false, turnInjectedTechniqueId: null,
  lastAssembledAtIso: null, assemblerOverheadTokens: 0,
  ...over,
});

function ctxFor(turnCtx: Bag, over: Partial<TeardownContext> = {}): TeardownContext {
  return {
    agentId: AGENT, turnCtx: turnCtx as never, turnNumber: TURN, db: mockDb.current!,
    chosenConvKey: 'dashboard:owner', chosenConversationId: CONV, lastAssembledAtIso: null,
    terminalAnswerRowId: 'answer-1', triggerWorkId: ASK,
    toolPhaseEndedBySpinBrake: false, turnInjectedTechniqueId: null,
    counterparty: { kind: 'user', name: 'David', relation: 'owner', channel: 'dashboard', senderId: 'owner', senderIsAgent: false } as never,
    isA2ATurn: false, isEngineTurn: false,
    turnStartedAt: new Date(Date.now() - 6_000).toISOString().slice(0, 19).replace('T', ' '),
    inboundChannel: 'dashboard', inboundContext: null,
    reArmIfStrandedNoAnswer: vi.fn(), stopStatusHeartbeat: vi.fn(),
    ...over,
  } as unknown as TeardownContext;
}

const markers = (workId = ASK): Array<Record<string, unknown>> => (mockDb.current!.prepare(
  `SELECT payload FROM work_events WHERE work_id = ? AND kind = 'audit'`,
).all(workId) as Array<{ payload: string }>)
  .map((r) => JSON.parse(r.payload) as Record<string, unknown>)
  .filter((p) => p.marker === 'answered_with_no_sources_consulted');

const markerLogs = (): Array<{ msg: string; data: Record<string, unknown> }> =>
  infos.filter((w) => /answered with nothing consulted/.test(w.msg));

/** The S1 turn's own shape: one model call, no tools, no recall, and a delivered answer. */
function s1State(over: Partial<AgentTurnState> = {}): AgentTurnState {
  const base = initState({ agentId: AGENT, maxToolLoops: 20, turnNumber: TURN } as Parameters<typeof initState>[0]);
  return advance(base, {
    toolCallsExecutedThisTurn: 0,
    recallLaneReachedModelThisTurn: false,
    ...over,
  });
}

function seedAsk(opts: { claimedByTurn?: number | null; requester?: string; kind?: string } = {}): void {
  const db = mockDb.current!;
  db.prepare(
    `INSERT INTO work (id, kind, agent_id, requester, root_kind, root_id, state, intent,
                       wakes, closes_thread, title, claimed_by_turn, opened_at, updated_at)
     VALUES (?, ?, ?, ?, 'ask', 'm-s1', 'claimed', 'ask', 1, 0,
             'Mount Si elevation gain and Discover Pass', ?, ?, ?)`,
  ).run(
    ASK, opts.kind ?? 'ask', AGENT, opts.requester ?? 'owner',
    opts.claimedByTurn === undefined ? TURN : opts.claimedByTurn,
    Date.now() - 6_000, Date.now(),
  );
}

beforeEach(() => {
  infos.length = 0;
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  mockDb.current = db;
  runMigrations();
  db.pragma('foreign_keys = ON');
  db.prepare(`INSERT INTO agents (id, name, status, session_started_at) VALUES (?, 'BehaviorBot', 'idle', '1970-01-01')`).run(AGENT);
  db.prepare(`INSERT INTO conversations (id, agent_id, channel, counterparty_id) VALUES (?, ?, 'dashboard', 'owner')`).run(CONV, AGENT);
  db.prepare(
    `INSERT INTO turns (agent_id, turn_number, kind, subject_kind, subject_id, root_kind, root_id,
                        source_message_id, conv_key, answered, effectful_calls, started_at)
     VALUES (?, ?, 'user', 'conv', ?, 'message', 'm-s1', 'm-s1', 'dashboard:owner', 0, 0, datetime('now'))`,
  ).run(AGENT, TURN, CONV);
  db.prepare(
    `INSERT INTO messages (id, agent_id, role, content, lane, conversation_id, turn_number)
     VALUES ('answer-1', ?, 'assistant', 'Mount Si gains about 3,150 feet…', 'owner', ?, ?)`,
  ).run(AGENT, CONV, TURN);
});

// ── RED → GREEN ─────────────────────────────────────────────────────────────────────────

describe('the S1 shape leaves a countable record', () => {
  it('RED→GREEN: fresh owner ask, zero tools, zero recall, answered — one log line and one durable marker', async () => {
    seedAsk();
    await finalizeTurnRecord(s1State(), ctxFor(turnCtxFor()));

    expect(markerLogs()).toHaveLength(1);
    expect(markerLogs()[0].data).toMatchObject({ agentId: AGENT, turnNumber: TURN, askId: ASK });
    expect(markers()).toHaveLength(1);
    expect(markers()[0]).toMatchObject({
      marker: 'answered_with_no_sources_consulted',
      turn_number: TURN, channel: 'dashboard', exit_reason: 'answered',
    });
  });

  it('the marker survives the settlement that runs one statement earlier', async () => {
    // `settleAsksAtTurnFinalize` NULLS `claimed_by_turn`, which is the freshness clause. The
    // read is taken BEFORE it for exactly that reason; this is the regression that would
    // otherwise be silent (the marker simply stops being written, forever, with no failure).
    seedAsk();
    await finalizeTurnRecord(s1State(), ctxFor(turnCtxFor()));
    const after = mockDb.current!.prepare('SELECT claimed_by_turn FROM work WHERE id = ?').get(ASK) as { claimed_by_turn: number | null };
    expect(after.claimed_by_turn, 'settlement really did clear it — so the read had to be earlier').toBeNull();
    expect(markers()).toHaveLength(1);
  });

  it('it records the DELIVERY receipt beside the answer key — two facts, not one', async () => {
    seedAsk();
    await finalizeTurnRecord(s1State(), ctxFor(turnCtxFor()));
    expect(markers()[0]).toHaveProperty('delivered_receipt');
  });
});

// ── CONTROLS: every clause of the signature, one at a time ──────────────────────────────

describe('CONTROLS — the marker fires on the shape and on nothing else', () => {
  it('a turn that USED A TOOL writes no marker (the tool row is the source)', async () => {
    seedAsk();
    await finalizeTurnRecord(
      s1State({ toolCallsExecutedThisTurn: 3 }),
      ctxFor(turnCtxFor({ anyToolStartedThisTurn: true })),
    );
    expect(markers()).toHaveLength(0);
    expect(markerLogs()).toHaveLength(0);
  });

  it('the two tool signals are read TOGETHER — a latch without a count, or a count without a latch, is not the shape', async () => {
    seedAsk();
    await finalizeTurnRecord(s1State({ toolCallsExecutedThisTurn: 1 }), ctxFor(turnCtxFor()));
    expect(markers(), 'zero-latch but a non-zero count must not be counted as "no tools"').toHaveLength(0);
  });

  it('a turn SERVED RECALLED MEMORY writes no marker — it consulted something', async () => {
    seedAsk();
    await finalizeTurnRecord(
      s1State({ recallLaneReachedModelThisTurn: true }),
      ctxFor(turnCtxFor()),
    );
    expect(markers()).toHaveLength(0);
  });

  it('a turn that did NOT answer writes no marker — silence is a different class', async () => {
    seedAsk();
    await finalizeTurnRecord(s1State(), ctxFor(turnCtxFor(), { terminalAnswerRowId: null }));
    expect(markers()).toHaveLength(0);
  });

  it('a REDRIVE of an ask another turn claimed writes no marker — "fresh" means this turn picked it up', async () => {
    seedAsk({ claimedByTurn: TURN - 7 });
    await finalizeTurnRecord(s1State(), ctxFor(turnCtxFor()));
    expect(markers()).toHaveLength(0);
  });

  it('an A2A turn and an ENGINE turn write no marker — a peer and a scheduler are not the owner asking', async () => {
    seedAsk();
    await finalizeTurnRecord(s1State(), ctxFor(turnCtxFor(), { isA2ATurn: true }));
    expect(markers()).toHaveLength(0);
    await finalizeTurnRecord(s1State(), ctxFor(turnCtxFor(), { isEngineTurn: true }));
    expect(markers()).toHaveLength(0);
  });

  it('an agent counterparty writes no marker', async () => {
    seedAsk();
    await finalizeTurnRecord(s1State(), ctxFor(turnCtxFor(), {
      counterparty: { kind: 'agent', name: 'Ticky', senderIsAgent: true } as never,
    }));
    expect(markers()).toHaveLength(0);
  });

  it('a COMMITMENT trigger writes no marker — the class is asks', async () => {
    seedAsk({ kind: 'commitment' });
    await finalizeTurnRecord(s1State(), ctxFor(turnCtxFor()));
    expect(markers()).toHaveLength(0);
  });

  it('an ask the AGENT raised for itself writes no marker — `requester` must be the owner', async () => {
    seedAsk({ requester: 'agent' });
    await finalizeTurnRecord(s1State(), ctxFor(turnCtxFor()));
    expect(markers()).toHaveLength(0);
  });

  it('a turn with NO trigger ask invents no row to hang a marker on', async () => {
    await finalizeTurnRecord(s1State(), ctxFor(turnCtxFor(), { triggerWorkId: null }));
    expect(
      (mockDb.current!.prepare(`SELECT COUNT(*) c FROM work_events`).get() as { c: number }).c,
    ).toBe(0);
  });
});

// ── THE STANDING BOUNDS ─────────────────────────────────────────────────────────────────

describe('the marker measures and does nothing else', () => {
  it('MEASUREMENT ONLY: the answer still stands, the turn record still reads answered, no steer is filed', async () => {
    seedAsk();
    await finalizeTurnRecord(s1State(), ctxFor(turnCtxFor()));
    const turn = mockDb.current!.prepare(
      'SELECT exit_reason, answered, answer_message_id FROM turns WHERE agent_id = ? AND turn_number = ?',
    ).get(AGENT, TURN) as { exit_reason: string; answered: number; answer_message_id: string | null };
    expect(turn).toMatchObject({ exit_reason: 'answered', answered: 1, answer_message_id: 'answer-1' });
    // The marker's ONLY write is its own audit row. Everything else on the ask's ledger is
    // the settlement's own transition, which happens identically with the marker removed —
    // so no steer, no nudge, no second obligation and no engine-authored row rode in.
    const kinds = (mockDb.current!.prepare(
      `SELECT kind, COUNT(*) AS n FROM work_events WHERE work_id = ? GROUP BY kind ORDER BY kind`,
    ).all(ASK) as Array<{ kind: string; n: number }>);
    expect(markers()).toHaveLength(1);
    // The other audit row is the settlement authority's own machine-readable observation,
    // and the transition is the ask closing. Both happen identically with the marker removed.
    expect(kinds.map((k) => k.kind).filter((k) => k !== 'audit' && k !== 'transition')).toEqual([]);
  });

  it('it reads no prose — the ask\'s own text is never touched by the predicate', async () => {
    // The same shape with a title that has no factual specifics in it at all still counts:
    // the engine is counting a SHAPE, which is the whole reason this is allowed to exist.
    seedAsk();
    mockDb.current!.prepare('UPDATE work SET title = ? WHERE id = ?').run('hi', ASK);
    await finalizeTurnRecord(s1State(), ctxFor(turnCtxFor()));
    expect(markers()).toHaveLength(1);
  });
});
