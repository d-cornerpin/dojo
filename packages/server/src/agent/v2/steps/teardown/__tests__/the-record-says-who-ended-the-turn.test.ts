// ════════════════════════════════════════════════════════════════════════════════════════
// THE RECORD SAYS WHO ENDED THE TURN — t93 (BACKLOG line 17), driven end to end.
//
// ── THE DEFECT ──────────────────────────────────────────────────────────────────────────
// "an owner pressing STOP is recorded as the model choosing silence and SPENDS an
// anti-repetition rung." Eight of `TurnExitReason`'s seventeen words had no writer (0 rows
// each in 10,934 turns), so every one of those causes fell through this recorder's ternary to
// `no_reply_intended` — a claim about the model's INTENT — and `work/ask-settlement.ts`'s
// re-serve ladder charged a rung for it. Four presses and the owner's unanswered question
// stops being re-served, having been neither answered nor declined.
//
// ── WHAT THIS FILE DRIVES, AND WHY IT IS THIS FUNCTION ──────────────────────────────────
// `finalizeTurnRecord` is the ONE production writer of `turns.exit_reason` on the live path,
// and it is also where the settlement runs — `finalizeTurn` writes the row and
// `settleAsksAtTurnFinalize` reads it back a few statements later, which is what makes the
// classification BITE rather than merely be recorded. So every clause here calls the real
// function against a real migrated database and then reads the real row and the real ask.
// No unit of the classifier stands in for the chain.
//
// §4 is the clause the whole item exists for: an owner's stop, on an ask the ladder has
// already walked to its bound, hands the ask back OPEN and spends nothing — and the control
// beside it proves the bound is still armed for a genuine silence.
// ════════════════════════════════════════════════════════════════════════════════════════

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';

const mockDb: { current: Database.Database | null } = { current: null };

vi.mock('../../../../../db/connection.js', async () => {
  const os = await import('node:os');
  const p = await import('node:path');
  return {
    getDb: () => {
      if (!mockDb.current) throw new Error('test DB not initialized');
      return mockDb.current;
    },
    closeDb: vi.fn(),
    getDbPath: () => p.join(os.tmpdir(), 'dojo-t93-record', 'dojo.db'),
  };
});

import { runMigrations } from '../../../../../db/migrations.js';
import { finalizeTurnRecord } from '../finalize-record.js';
import { latchEngineCut } from '../../../engine-exit.js';
import { markTurnDied, type EngineCutReason, type TurnExitReason } from '../../../turn-record.js';
import { advance, initState, type AgentTurnState } from '../../../state.js';
import type { TeardownContext } from '../index.js';
import { askIdForMessage, claimAsk, stampClaimingTurn } from '../../../../../work/store.js';
import { MAX_ASK_RE_SERVES, RE_SERVE_MARKER } from '../../../../../work/ask-settlement.js';
import { insertMessage } from '../../../../../memory/message-store.js';

const AGENT = 'agent-under-test';
const CONV = 'conv-dashboard';
const TURN = 512;

const db = (): Database.Database => mockDb.current!;

// ── The turn's bag, and the step context. Only the fields this recorder reads. ──
interface Bag { [k: string]: unknown }
const bagFor = (over: Record<string, unknown> = {}): Bag => ({
  agentId: AGENT, root: undefined, servedWork: undefined, convKey: 'dashboard:owner',
  startAckSteerRequested: false, startAckSteerArmedThisTurn: false,
  engineStartAckDeliveredThisTurn: false, startAckSteersInjected: 0,
  anyToolStartedThisTurn: false, toolPhaseEndedBySpinBrake: false,
  turnInjectedTechniqueId: null, lastAssembledAtIso: null, assemblerOverheadTokens: 0,
  ...over,
});

function ctxFor(over: Partial<TeardownContext> = {}, bag: Record<string, unknown> = {}): TeardownContext {
  return {
    agentId: AGENT, turnCtx: bagFor(bag) as never, turnNumber: TURN, db: db(),
    chosenConvKey: 'dashboard:owner', chosenConversationId: CONV, lastAssembledAtIso: null,
    terminalAnswerRowId: null, triggerWorkId: null,
    toolPhaseEndedBySpinBrake: false, toolLoopCapReached: false, turnInjectedTechniqueId: null,
    counterparty: {
      kind: 'user', name: 'the owner', relation: 'owner', channel: 'dashboard',
      senderId: 'owner', senderIsAgent: false,
    } as never,
    isA2ATurn: false, isEngineTurn: false,
    turnStartedAt: new Date(Date.now() - 60_000).toISOString().slice(0, 19).replace('T', ' '),
    inboundChannel: 'dashboard', inboundContext: null,
    reArmIfStrandedNoAnswer: vi.fn(), stopStatusHeartbeat: vi.fn(),
    ...over,
  } as unknown as TeardownContext;
}

const freshState = (): AgentTurnState => initState({
  agentId: AGENT, contextWindow: 200_000, isAutoRouted: false, configuredModelId: 'model-1',
  turnNumber: TURN, triggeredByIMessage: false, triggeredByA2AReplyIntent: null,
  lastUserMessageContent: null, lastUserMessageId: null, inboundChannel: 'dashboard',
  inboundContext: null, pendingTechniqueAck: null,
});

const openTurn = (turn = TURN): void => {
  db().prepare(
    `INSERT INTO turns (agent_id, turn_number, kind, subject_kind, subject_id, conv_key,
                        answered, effectful_calls, started_at)
     VALUES (?, ?, 'user', 'conv', ?, 'dashboard:owner', 0, 0, datetime('now','-60 seconds'))`,
  ).run(AGENT, turn, CONV);
};

const rowFor = (turn = TURN): { exit_reason: string | null; answered: number; ended_at: string | null } =>
  db().prepare('SELECT exit_reason, answered, ended_at FROM turns WHERE agent_id = ? AND turn_number = ?')
    .get(AGENT, turn) as { exit_reason: string | null; answered: number; ended_at: string | null };

/** Drive the real recorder and hand back the row it wrote. */
async function record(
  state: AgentTurnState, over: Partial<TeardownContext> = {}, bag: Record<string, unknown> = {},
): Promise<{ exit_reason: string | null; answered: number; ended_at: string | null }> {
  await finalizeTurnRecord(state, ctxFor(over, bag));
  return rowFor();
}

const cut = (reason: EngineCutReason): AgentTurnState => latchEngineCut(freshState(), reason);

beforeEach(() => {
  const d = new Database(':memory:');
  d.pragma('foreign_keys = ON');
  mockDb.current = d;
  runMigrations();
  d.pragma('foreign_keys = ON');
  d.prepare("INSERT INTO agents (id, name, classification, status) VALUES (?, 'A', 'sensei', 'idle')").run(AGENT);
  d.prepare(
    `INSERT INTO conversations (id, agent_id, channel, provider, counterparty_id)
     VALUES (?, ?, 'dashboard', 'dashboard', 'owner')`,
  ).run(CONV, AGENT);
  openTurn();
});

afterEach(() => {
  mockDb.current?.close();
  mockDb.current = null;
});

// ════════════════════════════════════════════════════════════════════════════════════════
// §1 — THE EIGHT, EACH LANDING ITS OWN WORD (D6's backwards-lifecycle probes)
// ════════════════════════════════════════════════════════════════════════════════════════

describe('§1 each cause the engine knows about reaches the row as itself', () => {
  const CUTS: ReadonlyArray<[EngineCutReason, string]> = [
    ['stop', 'the owner pressed stop (the gate, the model call, or the executor mid-batch)'],
    ['preempt', 'a peer or a barge-in took the turn'],
    ['abort', 'an external signal cut the call — not the stop door, not the watchdog'],
    ['terminated', 'the engine reaper closed a run nothing was going to finish'],
    ['budget', 'the unattended budget trip, and the 15-minute checkpoint continuation'],
    ['provider_error', 'a provider verdict ended the turn'],
    ['stream_idle', 'the stream watchdog cut the dial'],
  ];

  for (const [reason, what] of CUTS) {
    it(`${reason} — ${what}`, async () => {
      const row = await record(cut(reason));
      expect(row.exit_reason, `${reason} did not reach the row`).toBe(reason);
      expect(row.ended_at, 'the row must be closed').not.toBeNull();
      expect(row.answered, 'no reply was delivered, and that is a separate column').toBe(0);
    });
  }

  it('identical_call — the engine refused this turn\'s repeated calls', async () => {
    const state = advance(freshState(), { identicalCallRefusedThisTurn: true });
    expect((await record(state)).exit_reason).toBe('identical_call');
  });

  it('a cut turn that DID deliver records the cut AND the answer — two columns, two facts', async () => {
    db().prepare(
      `INSERT INTO messages (id, agent_id, role, content, lane, conversation_id, turn_number)
       VALUES ('m-answer', ?, 'assistant', 'Here is what I found so far.', 'owner', ?, ?)`,
    ).run(AGENT, CONV, TURN);
    const row = await record(cut('stop'), { terminalAnswerRowId: 'm-answer' });
    expect(row.exit_reason, 'the stop is WHY the turn ended').toBe('stop');
    expect(row.answered, 'and the reply still went out — the PHASE-2 split exists for this pair').toBe(1);
  });
});

// ════════════════════════════════════════════════════════════════════════════════════════
// §2 — WHAT MUST NOT MOVE: the six words the recorder could always write
// ════════════════════════════════════════════════════════════════════════════════════════

describe('§2 an ordinary turn lands exactly the word it always did', () => {
  it('answered — a delivered reply, with nothing latched', async () => {
    db().prepare(
      `INSERT INTO messages (id, agent_id, role, content, lane, conversation_id, turn_number)
       VALUES ('m-answer', ?, 'assistant', 'All three are in stock.', 'owner', ?, ?)`,
    ).run(AGENT, CONV, TURN);
    const row = await record(freshState(), { terminalAnswerRowId: 'm-answer' });
    expect(row.exit_reason).toBe('answered');
    expect(row.answered).toBe(1);
  });

  it('no_reply_intended — the model saw the ask and chose silence, which is still sayable', async () => {
    expect((await record(freshState())).exit_reason).toBe('no_reply_intended');
  });

  it('brake — and it still OUTRANKS a delivered reply (d54cd1f\'s class)', async () => {
    db().prepare(
      `INSERT INTO messages (id, agent_id, role, content, lane, conversation_id, turn_number)
       VALUES ('m-answer', ?, 'assistant', 'Coerced wrap-up.', 'owner', ?, ?)`,
    ).run(AGENT, CONV, TURN);
    const row = await record(freshState(), {
      toolPhaseEndedBySpinBrake: true, terminalAnswerRowId: 'm-answer',
    });
    expect(row.exit_reason).toBe('brake');
  });

  it('brake — and it outranks a latched cut too, which is the precedence this task chose', async () => {
    // Both words are in ENGINE_IMPOSED_EXITS, so the settlement cannot tell them apart; the
    // order is kept because an existing guard pins it for a measured defect class.
    expect((await record(cut('stop'), { toolPhaseEndedBySpinBrake: true })).exit_reason).toBe('brake');
  });

  it('iteration_cap — C2\'s word, unaffected, and still below a cut', async () => {
    expect((await record(freshState(), { toolLoopCapReached: true })).exit_reason).toBe('iteration_cap');
    openTurn(TURN + 1);
    await finalizeTurnRecord(cut('budget'), ctxFor({ turnNumber: TURN + 1, toolLoopCapReached: true }));
    expect(rowFor(TURN + 1).exit_reason, 'the cut is the proximate cause').toBe('budget');
  });

  it('park — a turn that delegated the ask it was serving', async () => {
    db().prepare(
      `INSERT INTO work (id, kind, agent_id, requester, root_kind, root_id, state, intent,
                         wakes, closes_thread, title, remaining_children, opened_at, updated_at)
       VALUES ('w-park', 'ask', ?, 'owner', 'message', 'm-1', 'claimed', 'answer', 1, 0,
               'Compare the three options', 1, ?, ?)`,
    ).run(AGENT, Date.now() - 60_000, Date.now());
    expect((await record(freshState(), { triggerWorkId: 'w-park' })).exit_reason).toBe('park');
  });

  it('handoff — the turn spoke on the a2a lane instead of answering', async () => {
    db().prepare(
      `INSERT INTO messages (id, agent_id, role, content, lane, conversation_id, turn_number)
       VALUES ('m-a2a', ?, 'assistant', 'Taking this one, will report back.', 'a2a', ?, ?)`,
    ).run(AGENT, CONV, TURN);
    expect((await record(freshState())).exit_reason).toBe('handoff');
  });

  it('identical_call sits BELOW the cap and the handoff, never above them', async () => {
    const refused = advance(freshState(), { identicalCallRefusedThisTurn: true });
    expect((await record(refused, { toolLoopCapReached: true })).exit_reason).toBe('iteration_cap');
  });
});

// ════════════════════════════════════════════════════════════════════════════════════════
// §3 — THE INJURY PATH CARRIES THE SAME WORD
//
// `recordInjury` closes the row itself (`AND ended_at IS NULL`) about forty statements ahead
// of the recorder, so on a thrown turn the injury path's word is the one that lands.
// ════════════════════════════════════════════════════════════════════════════════════════

describe('§3 a thrown turn records what the engine observed, and `unknown` still means unknown', () => {
  it('the observed cut lands, and the recorder\'s later write cannot overwrite it', async () => {
    markTurnDied(AGENT, TURN, 'stream_idle');
    expect(rowFor().exit_reason).toBe('stream_idle');
    // The `finally` arm still runs; its UPDATE is scoped to an open row and finds none.
    await finalizeTurnRecord(freshState(), ctxFor());
    expect(rowFor().exit_reason, 'the first honest writer wins, as it always did').toBe('stream_idle');
  });

  it('an unclassifiable throw keeps the quarantine value', () => {
    markTurnDied(AGENT, TURN);
    expect(rowFor().exit_reason).toBe('unknown');
    expect(rowFor().answered).toBe(0);
  });
});

// ════════════════════════════════════════════════════════════════════════════════════════
// §4 — THE CLASSIFICATION BITES: the owner's STOP does not park an ask or spend a rung
//
// THE ITEM'S OWN SENTENCE, driven through the real settlement rather than a unit of the
// classifier: `finalizeTurnRecord` writes the row, and `settleAsksAtTurnFinalize` — invoked
// from inside the same function a few statements later — reads it back and decides.
// ════════════════════════════════════════════════════════════════════════════════════════

describe('§4 an owner\'s stop is not the model\'s silence, all the way through', () => {
  const ASK = (): string => askIdForMessage('m-ask');

  const claimedAsk = (turn: number): string => {
    insertMessage({
      id: 'm-ask', agentId: AGENT, role: 'user',
      content: 'Compare the three options and tell me which to buy',
      conversationId: CONV, channel: 'dashboard', senderId: 'owner',
      displayKind: 'user-text', lane: 'owner',
    } as never);
    claimAsk(ASK(), AGENT);
    stampClaimingTurn(ASK(), turn);
    return ASK();
  };
  const reclaim = (turn: number): void => { claimAsk(ASK(), AGENT); stampClaimingTurn(ASK(), turn); };
  const askState = (): string => (db().prepare('SELECT state FROM work WHERE id = ?')
    .get(ASK()) as { state: string }).state;
  const rungs = (): number => (db().prepare(
    `SELECT COUNT(*) AS n FROM work_events WHERE work_id = ? AND kind = 'audit'
       AND json_extract(payload, '$.marker') = ?`,
  ).get(ASK(), RE_SERVE_MARKER) as { n: number }).n;
  const lastReason = (): string => {
    const rows = db().prepare(
      `SELECT payload FROM work_events WHERE work_id = ? AND kind = 'transition' ORDER BY id`,
    ).all(ASK()) as Array<{ payload: string }>;
    return (JSON.parse(rows[rows.length - 1].payload) as { reason: string }).reason;
  };

  /** Finalize turn `n` with the given cause, through the real recorder. */
  const finalizeAs = async (turn: number, state: AgentTurnState): Promise<void> => {
    openTurn(turn);
    await finalizeTurnRecord(state, ctxFor({ turnNumber: turn }));
  };

  it('ONE stop: the ask goes back OPEN, the record says `stop`, and the ladder does not move', async () => {
    claimedAsk(TURN);
    await finalizeTurnRecord(cut('stop'), ctxFor());
    expect(rowFor().exit_reason).toBe('stop');
    expect(askState(), 'the person is still waiting').toBe('open');
    expect(rungs(), 'an owner\'s press is not a serve the model spent').toBe(0);
    expect(lastReason()).toContain('the engine ended the turn');
  });

  it('AT THE BOUND: three genuine silences, then a stop — handed back, never parked', async () => {
    // The shape the item describes. Without the writer the fourth turn records
    // `no_reply_intended`, spends the last rung, and the ask is stood down to `blocked` —
    // the state the drain's `state = 'open'` queue stops picking up.
    claimedAsk(1);
    for (let i = 0; i < MAX_ASK_RE_SERVES; i++) {
      await finalizeAs(1 + i, freshState());
      expect(rowFor(1 + i).exit_reason, 'the control half must be a real silence').toBe('no_reply_intended');
      reclaim(2 + i);
    }
    expect(rungs(), 'at the bound').toBe(MAX_ASK_RE_SERVES);

    await finalizeAs(1 + MAX_ASK_RE_SERVES, cut('stop'));
    expect(rowFor(1 + MAX_ASK_RE_SERVES).exit_reason).toBe('stop');
    expect(askState(), 'a stop must never be the press that parks an owner\'s question').toBe('open');
    expect(rungs(), 'and it spends nothing').toBe(MAX_ASK_RE_SERVES);

    // …AND THE BOUND IS STILL ARMED. The anti-repetition half is the owner's other standing
    // complaint; only the cut is exempt.
    reclaim(2 + MAX_ASK_RE_SERVES);
    await finalizeAs(2 + MAX_ASK_RE_SERVES, freshState());
    expect(askState(), 'a genuine silence at the bound still stands the re-serve down').toBe('blocked');
  });

  it('every one of the eight is exempt, driven through the recorder and the ladder', async () => {
    const reasons: TurnExitReason[] = ['stop', 'preempt', 'abort', 'terminated', 'budget',
      'provider_error', 'stream_idle', 'identical_call'];
    claimedAsk(1);
    let turn = 1;
    for (const reason of reasons) {
      const state = reason === 'identical_call'
        ? advance(freshState(), { identicalCallRefusedThisTurn: true })
        : cut(reason as EngineCutReason);
      await finalizeAs(turn, state);
      expect(rowFor(turn).exit_reason, reason).toBe(reason);
      expect(askState(), reason).toBe('open');
      expect(rungs(), `${reason} spent a rung`).toBe(0);
      reclaim(++turn);
    }
  });
});
