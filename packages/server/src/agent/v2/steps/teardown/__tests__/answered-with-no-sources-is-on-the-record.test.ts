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
//
// ── UX-REPAIR ROUND 14 / T64 — THE COUNTER THAT COULD NOT COUNT ─────────────────────────
// It wrote ZERO rows, EVER — including round-14 S1, the shape it was built for. The fourth
// clause was the killer and the reason is a MISATTRIBUTION, not an off-by-one: it asked
// whether `msg.relevant-memory` reached the model, and that lane is an UNCONDITIONAL ENGINE
// PUSH. Nobody consults it. It is retrieved against a 500-char blob of the recent human rows
// and injected on every counterparty (`pre-call-injections.ts`, the recall-lane block), so
// "the lane reached the model" is very nearly a constant.
//
// Driven at HEAD on the dev box (W47, 2026-08-17, receipts on for the drive):
//   · t4992 "what year did the Alaskan Way Viaduct come down…" — user turn, exit `answered`,
//     `effectful_calls` 0, fresh owner ask claimed by that very turn → 0 marker rows.
//   · t4993 "how tall is the Space Needle…" — same shape, same nothing.
//   · both iterations of both turns carried `msg.relevant-memory`, ADMITTED, 725 tokens, and
//     in `full` mode its body was: three of the agent's OWN previously-answered questions
//     (from the answer stamps) plus four vault notes — an airport parking spot, a gym locker
//     code, a remembered phrase, a website-hosting decision — and the obligations snapshot.
//     Not one line of it could be the source of the Space Needle's height, and the engine may
//     not read prose to say so.
//
// So the clause measured THE ENGINE'S act and vetoed on it as though it were THE AGENT'S.
// The agent's own consulting is its tool calls, which is clause 3 and is already exact. The
// engine's push is still a fact worth having, so it moves to the PAYLOAD where a later round
// can slice on it — measurement, which is this marker's entire charter, instead of a veto
// that made the class unobservable.
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

/**
 * ⚠ T64 — THE FIXTURE NOW SEEDS WHAT PRODUCTION ACTUALLY HAS, and its previous shape is why
 * this file was green while the marker wrote nothing for its whole life. It seeded a `claimed`
 * ask carrying `claimed_by_turn = TURN`; a real ask has been `done` with that column NULLED
 * since the millisecond its reply was delivered, because `transition()` clears it on every
 * move out of `claimed`. The durable record of who claimed it is the `claim_turn` EVENT, which
 * is what the predicate reads and what this seeds.
 */
function seedAsk(opts: { claimedByTurn?: number | null; requester?: string; kind?: string } = {}): void {
  const db = mockDb.current!;
  const claimTurn = opts.claimedByTurn === undefined ? TURN : opts.claimedByTurn;
  db.prepare(
    `INSERT INTO work (id, kind, agent_id, requester, root_kind, root_id, state, intent,
                       wakes, closes_thread, title, claimed_by_turn, opened_at, updated_at)
     VALUES (?, ?, ?, ?, 'ask', 'm-s1', 'claimed', 'ask', 1, 0,
             'Mount Si elevation gain and Discover Pass', NULL, ?, ?)`,
  ).run(ASK, opts.kind ?? 'ask', AGENT, opts.requester ?? 'owner', Date.now() - 6_000, Date.now());
  if (claimTurn !== null) {
    db.prepare(
      `INSERT INTO work_events (work_id, kind, actor, payload, created_at)
       VALUES (?, 'claim_turn', 'engine', ?, ?)`,
    ).run(ASK, JSON.stringify({ turn_number: claimTurn }), Date.now() - 6_000);
  }
}

/** The production shape at teardown: the ask CLOSED mid-turn on its own delivery. */
function closeAskOnDeliveryMidTurn(): void {
  // The DB's own CHECK insists a `done` row names the delivery that answered it, which is the
  // same two-halves rule the answered edge keeps — so the fixture states one.
  mockDb.current!.prepare(
    `INSERT INTO deliveries (id, agent_id, channel, outcome, tool, created_at)
     VALUES ('d-s1', ?, 'dashboard', 'delivered', 'reply_to_user', ?)`,
  ).run(AGENT, Date.now());
  mockDb.current!.prepare(
    `UPDATE work SET state = 'done', claimed_by_turn = NULL, closed_at = ?,
            result_delivery_id = 'd-s1' WHERE id = ?`,
  ).run(Date.now(), ASK);
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

  it('T64 RED→GREEN: the ask CLOSED MID-TURN on its own delivery — the freshness clause still knows which turn claimed it', async () => {
    // THE OTHER HALF OF THE ZERO. The old clause read `work.claimed_by_turn` and placed itself
    // above `settleAsksAtTurnFinalize` to beat that authority's NULLing. It was already beaten:
    // an ordinary answered ask goes `claimed -> done` the moment its reply is delivered, and
    // `transition()` NULLs the column on every move out of `claimed`. Driven at HEAD on t4996:
    // `claimedByTurn: null` against `turnNumber: 4996`. This is that turn, in a fixture.
    seedAsk();
    closeAskOnDeliveryMidTurn();
    const before = mockDb.current!.prepare('SELECT state, claimed_by_turn FROM work WHERE id = ?').get(ASK) as { state: string; claimed_by_turn: number | null };
    expect(before, 'the shape under test is a CLOSED ask with no claim column left').toMatchObject({ state: 'done', claimed_by_turn: null });
    await finalizeTurnRecord(s1State(), ctxFor(turnCtxFor()));
    expect(markers()).toHaveLength(1);
    expect(markers()[0]).toMatchObject({ turn_number: TURN });
  });

  it('it records the DELIVERY receipt beside the answer key — two facts, not one', async () => {
    seedAsk();
    await finalizeTurnRecord(s1State(), ctxFor(turnCtxFor()));
    expect(markers()[0]).toHaveProperty('delivered_receipt');
  });

  it('T64: the engine\'s recall push is RECORDED in the payload — both ways round, so the class stays sliceable', async () => {
    seedAsk();
    await finalizeTurnRecord(s1State({ recallLaneReachedModelThisTurn: true }), ctxFor(turnCtxFor()));
    expect(markers()[0]).toMatchObject({ recall_lane_reached: true });
    expect(markerLogs()[0].data).toMatchObject({ recallLaneReached: true });

    // And the other side of the same field: a turn the lane did NOT reach says so, rather
    // than the field being a constant nobody can filter on.
    infos.length = 0;
    mockDb.current!.prepare(`DELETE FROM work_events WHERE kind = 'audit'`).run();
    mockDb.current!.prepare(`UPDATE work SET state = 'claimed', closed_at = NULL WHERE id = ?`).run(ASK);
    await finalizeTurnRecord(s1State({ recallLaneReachedModelThisTurn: false }), ctxFor(turnCtxFor()));
    expect(markers()[0]).toMatchObject({ recall_lane_reached: false });
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

  // ── T64: THIS CLAUSE IS GONE, AND ITS OLD ASSERTION IS THE DEFECT IT PINNED ──
  // What stood here demanded ZERO markers when the recall lane had reached the model, and
  // because that lane reaches the model on very nearly every turn, this one assertion is
  // what held the counter at zero rows for its whole life. It is REPLACED, not loosened:
  // the fact it keyed on is now asserted in the payload two describes below, and the veto
  // it granted to an engine push is asserted GONE right here.
  it('T64 RED→GREEN: the engine\'s own recall PUSH no longer vetoes — the S1 shape as it really runs', async () => {
    seedAsk();
    await finalizeTurnRecord(
      // The driven truth of t4992/t4993: this latch is TRUE on the S1 shape, every time.
      s1State({ recallLaneReachedModelThisTurn: true }),
      ctxFor(turnCtxFor()),
    );
    expect(markers(), 'the counter must count the shape it was built for').toHaveLength(1);
    expect(markerLogs()).toHaveLength(1);
  });

  it('T64: a turn where the AGENT ITSELF read memory writes no marker — a lookup is a tool row', async () => {
    // This is the surviving, satisfiable referent of "a recall-hit turn writes nothing". A
    // recall the AGENT performs is a tool call (`vault`, `read_file`, a search — every one of
    // them lands a tool row), so clause 3 refuses it exactly as it refuses any other lookup.
    // What no longer refuses anything is the lane the ENGINE pushes with nobody asking.
    seedAsk();
    await finalizeTurnRecord(
      s1State({ toolCallsExecutedThisTurn: 1, recallLaneReachedModelThisTurn: true }),
      ctxFor(turnCtxFor({ anyToolStartedThisTurn: true })),
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
    // `claim_turn` is the fixture's own seed (the record production writes when the turn picks
    // the ask up), not something this boundary wrote.
    expect(kinds.map((k) => k.kind).filter((k) => k !== 'audit' && k !== 'transition' && k !== 'claim_turn')).toEqual([]);
  });

  it('T64 HONEST BOUND: a GREETING counts too, and the count is therefore an upper bound', async () => {
    // Driven t4998, "Quick one — say hi." — a marker row, because that is this exact shape.
    // Pinned rather than papered over: telling a greeting from a factual ask means reading the
    // ask (the standing prose ban), and any length or word threshold would be invented (#14).
    // A reader of these counts must treat them as an UPPER BOUND on unsourced specifics. If a
    // future round wants the class narrowed, this clause is where the argument re-opens.
    seedAsk();
    mockDb.current!.prepare('UPDATE work SET title = ? WHERE id = ?').run('Quick one — say hi.', ASK);
    await finalizeTurnRecord(s1State(), ctxFor(turnCtxFor()));
    expect(markers()).toHaveLength(1);
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
