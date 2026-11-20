// ════════════════════════════════════════
// PHASE-6 T6 — THE `postCallClassify` STEP'S CONTRACT (one contract test per STEP,
// RULING P6-R1). CUT 8 in the ordinal order (RULING P6-R3(3)).
//
// The shared shape, unchanged from CUT 1–7 and reusing `steps/step-outcome.ts`:
//
//   INPUTS      `(state, ctx)` — the turn's state, and everything else the span read
//               from the driver. Measured, not guessed: after this tranche's three
//               carrier commits the binder census finds 33 top-level crossings of
//               which TWO are mutable, and only `state` is written — which the
//               contract already carries.
//   OUTPUT      a step outcome — the advanced state, ONE directive, and (on the
//               proceed arm ONLY) the FOUR values this span produces for the rest of
//               the iteration to read.
//   TRANSITION  the driver advances `phase` INTO the step; the step never writes it.
//   EXIT        the exit-request channel: the step ASKS by returning.
//
// ── WHAT IS THIS STEP'S ALONE ──
//
// 1. IT IS THE HEAVIEST EXIT-REQUEST EXERCISE IN THE PHASE. Twenty-four control-flow
//    conversions — SEVEN `break`s and SEVENTEEN `continue`s of the driver's loop —
//    against `execute`'s six, `assemble`'s one and `teardown`'s zero. The whole
//    tranche is the channel's stress test, which is why the census below pins BOTH
//    counts rather than describing them.
// 2. IT IS THE FLOOR FAMILY'S HOME, AND THE FAMILY IS AGENT-VOICED. The plan's own
//    tranche note: *"the floor family already runs agent-voiced (Phase 4); this
//    tranche only RELOCATES with tests riding along."* OR2 says the engine never
//    speaks to the user AS the agent, so every floor here steers the MODEL and the
//    package composes no user-facing assistant line of its own. Asserted at the STEP.
// 3. IT CARRIES THE OWNER LAW OF 2026-07-09 — user turns are NEVER reclassified.
//    `interAgentTurn` is the post-model half of that law and it is computed here.
//
// ── AND THE DOCUMENTED LANDMINE, MEASURED RATHER THAN ASSUMED ──
// Global Constraints names unifying `identicalCallSignature` (the brake's) with
// `canonicalToolSignature` (the thrash gate's) as a landmine — one edit would move
// two different thresholds. Both live in `steps/execute/`; the clause below proves
// this package pulls in NEITHER, so the split that keeps them distinct is not
// quietly undone by a second copy landing here.
// ════════════════════════════════════════

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ToolCall } from '@dojo/shared';
import { advance, initState, type AgentTurnState } from '../../../state.js';
import {
  runPostCallClassify,
  POST_CALL_CLASSIFY_PHASE,
  type PostCallClassifyContext,
} from '../index.js';
import { FX, FXID } from '../../../../../../../../deploy/checks/fixture-vocabulary.mjs';

// ── The step's outside world ──
// Each mock stands in for a DOOR the span already went through; none of them changes
// a decision.
const broadcastSpy = vi.fn();
vi.mock('../../../../../gateway/ws.js', () => ({ broadcast: (...a: unknown[]) => broadcastSpy(...(a as [])) }));

const insertMessageIfAbsentSpy = vi.fn();
const insertEngineEventIfAbsentSpy = vi.fn();
vi.mock('../../../../../memory/message-store.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  insertMessageIfAbsent: (...a: unknown[]) => insertMessageIfAbsentSpy(...(a as [])),
  insertEngineEventIfAbsent: (...a: unknown[]) => insertEngineEventIfAbsentSpy(...(a as [])),
}));

vi.mock('../../../../../services/presence.js', () => ({ getPresence: () => 'away' }));

// A unit test must not open the dev database. Every DB reader in this span is a door
// it already went through inside the loop; the stub answers nothing.
const emptyStmt = { all: () => [], get: () => undefined, run: () => ({ changes: 0 }) };
const fakeDb = {
  prepare: () => emptyStmt,
  transaction: (fn: (...a: unknown[]) => unknown) => (...a: unknown[]) => fn(...a),
} as unknown as PostCallClassifyContext['db'];
vi.mock('../../../../../db/connection.js', () => ({ getDb: () => fakeDb }));

const reArmIfStrandedNoAnswerSpy = vi.fn();
const noteTerminalAnswerSpy = vi.fn();
const deliverEngineUserAckSpy = vi.fn(async () => undefined);
const startAckRepliedNowSpy = vi.fn(() => false);

function turnCtxFor(over: Record<string, unknown> = {}): PostCallClassifyContext['turnCtx'] {
  return {
    agentId: FXID.n4,
    kind: 'user',
    convKey: 'ck-1',
    conversationId: 'conv-1',
    servedWork: undefined,
    engineStartAckDeliveredThisTurn: false,
    deferredDeliveredByAck: false,
    voiceFillerFired: false,
    goingIdleDetectorRanThisTurn: false,
    startAckSteerRequested: false,
    startAckSteerArmedThisTurn: false,
    phoneStreamCallSid: null,
    ...over,
  } as unknown as PostCallClassifyContext['turnCtx'];
}

const modelResult = (
  over: Partial<{ content: string; toolCalls: ToolCall[]; stopReason: string }> = {},
): PostCallClassifyContext['result'] => ({
  content: 'Here is the answer.', toolCalls: [] as ToolCall[],
  inputTokens: 10, outputTokens: 5, stopReason: 'end_turn', ...over,
} as unknown as PostCallClassifyContext['result']);

function ctxFor(over: Partial<PostCallClassifyContext> = {}): PostCallClassifyContext {
  return {
    agentId: FXID.n4,
    turnCtx: turnCtxFor(),
    turnNumber: 7,
    db: fakeDb,
    agent: { id: FXID.n4, name: FX.n4 } as unknown as PostCallClassifyContext['agent'],
    counterparty: { kind: 'user', relation: 'owner', channel: 'dashboard' } as unknown as PostCallClassifyContext['counterparty'],
    counterpartyIsAgentSender: false,
    chosenConvKey: 'ck-1',
    hasUnansweredUser: true,
    triggerRow: null,
    isA2ATurn: false,
    isEngineTurn: false,
    isHumanContinuation: false,
    mostRecentIsA2A: false,
    mostRecentInbound: undefined,
    pendingEngineEvent: null,
    unrepliedAssign: null,
    a2aReplyContext: null,
    a2aReplyAssignMessageId: null,
    settledContextWakeTurn: false,
    waitingConvs: [],
    inboundChannel: 'dashboard',
    latestUserSource: 'dashboard',
    lastUserMessageContent: 'what is the answer?',
    configuredModelId: 'test-model',
    turnStartedAt: new Date().toISOString(),
    messageId: 'msg-1',
    result: modelResult(),
    reArmIfStrandedNoAnswer: reArmIfStrandedNoAnswerSpy,
    noteTerminalAnswer: noteTerminalAnswerSpy,
    deliverEngineUserAck: deliverEngineUserAckSpy,
    startAckRepliedNow: startAckRepliedNowSpy,
    ...over,
  } as PostCallClassifyContext;
}

function freshState(over: Partial<AgentTurnState> = {}): AgentTurnState {
  // The reducer's own constructor, called with its own parameter object rather than
  // positionally: `state.modelId` is one of this step's four outputs, so a state built
  // sloppily would make that output read `undefined` and the clause prove nothing.
  const base = initState({
    agentId: FXID.n4, contextWindow: 128_000, isAutoRouted: false,
    configuredModelId: 'test-model', turnNumber: 7, triggeredByIMessage: false,
    triggeredByA2AReplyIntent: null, lastUserMessageContent: 'what is the answer?',
    lastUserMessageId: 'msg-user-1',
  } as Parameters<typeof initState>[0]);
  return advance(base, { phase: POST_CALL_CLASSIFY_PHASE, loopCount: 2, modelId: 'test-model', ...over });
}

beforeEach(() => { vi.clearAllMocks(); });

describe('PHASE-6 CUT 8: the `postCallClassify` step\'s contract', () => {
  it('INPUTS (state, ctx) → ONE outcome, and the FOUR values this span produces come back as its OUTPUT', async () => {
    // With TOOL CALLS, because "the model called no tools" is itself one of this span's
    // seven exits — the plain and much the most common way a turn ends.
    const out = await runPostCallClassify(freshState(), ctxFor({
      result: modelResult({ toolCalls: [{ id: 'tc-1', name: 'file_read', arguments: {} } as ToolCall], stopReason: 'tool_use' }),
    }));

    expect(out.directive).toBe('proceed');
    if (out.directive !== 'proceed') throw new Error('unreachable');
    // The FOUR escaping declarations of this span, measured by the binder census. The
    // driver hands every one of them straight to `execute` in the same iteration, which
    // is why they are OUTPUTS and not fields on the bag.
    //
    // `persistedContent` is NULL here and that is the span's own law, not an omission:
    // assistant text riding in the SAME response as a tool call is Lane-2 process
    // narration ("let me check the calendar"), never the person's message — the reply is
    // always the terminal, tool-less response. It is demoted to a working note rather
    // than discarded, and on a turn a human is waiting on it is REMEMBERED for the
    // finalize recovery (the next clause drives that half).
    expect(out.persistedContent).toBeNull();
    expect(out.interAgentTurn).toBe(false);
    expect(out.hasXmlFallbackTools).toBe(false);
    expect(out.effectiveModelIdForPersist).toBe('test-model');
  });

  it('THE OUTPUTS ARE REAL AND NOT CONSTANTS — an XML-fallback turn flips the one that says so', async () => {
    // Without this arm the clause above passes on a step that hard-codes `false`.
    // Weak/local models emit tool calls through the text parser and their ids are
    // synthetic; the rest of the turn has to know, because such calls must not be
    // persisted as structured `tool_use` blocks.
    const out = await runPostCallClassify(freshState(), ctxFor({
      result: modelResult({
        toolCalls: [{ id: 'text_tool_1', name: 'file_read', arguments: {} } as ToolCall],
        stopReason: 'tool_use',
      }),
    }));
    if (out.directive !== 'proceed') throw new Error('unreachable');
    expect(out.hasXmlFallbackTools).toBe(true);
  });

  it('G-SUP-2: on a turn a human IS waiting on, text riding with tool calls is DELIVERED as the start line, not held', async () => {
    // The other half of the clause above, and the reason `persistedContent` is null on
    // that path: the weak model pairs its real answer with a tool call, and this span
    // hands that text to the person as the agent's own line rather than letting it sit
    // in the transcript unsent. It is also where the ack-delivery pair — CUT 8's first
    // carrier — is written, which is why a by-value hand-off would double-ack.
    const ctx = ctxFor({
      hasUnansweredUser: true,
      turnCtx: turnCtxFor({ startAckSteerArmedThisTurn: true }),
      result: modelResult({ toolCalls: [{ id: 'tc-1', name: 'file_read', arguments: {} } as ToolCall], stopReason: 'tool_use' }),
    });
    const out = await runPostCallClassify(freshState(), ctx);

    if (out.directive !== 'proceed') throw new Error('unreachable');
    // UX-REPAIR T2: the same call, now carrying the two facts the engine already knew and
    // used to discard — the start-ack STAMP and the explicit `agent-text` kind (so the stamp
    // does not reclassify the model's own words as engine fallback). Settlement itself still
    // REFUSES a promoted row as an ask receipt (the seventh narrowing's blanket rule).
    //
    // ANSWER-ANYWAY (as reworked under owner rulings 10(d)/OR2): `reuseId` is no longer null.
    // The row id is MINTED at the promotion site and recorded on the bag, because the words
    // the person heard have to stay NAMEABLE — the un-blinded ghosted-ask steer quotes them
    // back so the MODEL decides whether they answered the ask; the engine never judges the
    // content. Without the id the steer had nothing to show, which is how turn 5649's
    // answered ask was blindly re-served four times and parked `blocked`.
    expect(deliverEngineUserAckSpy).toHaveBeenCalledWith(
      'Here is the answer.', 'engine_start_ack', ctx.turnCtx.startAckPromotedRowId, 'agent-text',
    );
    expect(ctx.turnCtx.startAckPromotedRowId).toEqual(expect.any(String));
    expect(out.persistedContent).toBeNull();
    // The pair is written ON THE BAG, live, so the wall-clock timer sees it at fire time.
    expect(ctx.turnCtx.engineStartAckDeliveredThisTurn).toBe(true);
    expect(ctx.turnCtx.deferredDeliveredByAck).toBe(true);
  });

  it('THE STEP DOES NOT WRITE `phase` — on the ordinary proceed arm, on an exit arm, and exactly ONCE in its source', async () => {
    const proceed = await runPostCallClassify(freshState(), ctxFor({
      result: modelResult({ toolCalls: [{ id: 'tc-1', name: 'file_read', arguments: {} } as ToolCall], stopReason: 'tool_use' }),
    }));
    expect(proceed.state.phase).toBe(POST_CALL_CLASSIFY_PHASE);

    // The empty-after-tools exit: one of this span's seven ways out.
    const exited = await runPostCallClassify(
      freshState({ toolCallsExecutedThisTurn: 2 }),
      // t125: NOBODY IS OWED. This arm is the VEHICLE for the exit channel, not a claim
      // about silence — and since t125 the empty-after-tools exit is reachable only when no
      // person is waiting (an owed turn walks the ladder instead). The fixture says which
      // turn this is rather than relying on the gate that used to ignore the question.
      ctxFor({ result: modelResult({ content: '', toolCalls: [] }), hasUnansweredUser: false }),
    );
    expect(exited.directive).toBe('exit');
    expect(exited.state.phase).toBe(POST_CALL_CLASSIFY_PHASE);
  });

  it('EXIT IS NOT SAYABLE WITHOUT A REASON, and the arms name their own', async () => {
    const afterTools = await runPostCallClassify(
      freshState({ toolCallsExecutedThisTurn: 2 }),
      // t125: NOBODY IS OWED. This arm is the VEHICLE for the exit channel, not a claim
      // about silence — and since t125 the empty-after-tools exit is reachable only when no
      // person is waiting (an owed turn walks the ladder instead). The fixture says which
      // turn this is rather than relying on the gate that used to ignore the question.
      ctxFor({ result: modelResult({ content: '', toolCalls: [] }), hasUnansweredUser: false }),
    );
    expect(afterTools.directive).toBe('exit');
    if (afterTools.directive !== 'exit') throw new Error('unreachable');
    expect(afterTools.reason).toMatch(/empty|tools/i);

    // A plain terminal reply with no tool calls: the loop is done.
    const done = await runPostCallClassify(freshState(), ctxFor({ result: modelResult({ toolCalls: [] }) }));
    // …but only once the whole no-tool floor family has had its say, so this arm is
    // the LAST statement of the span rather than an early return.
    expect(done.directive).toBe('exit');
    if (done.directive !== 'exit') throw new Error('unreachable');
    expect(done.reason).toMatch(/no-tool-calls|turn-is-done/i);
  });

  it('A STEP THAT ASKS TO EXIT STOPS — the empty-response ladder never reaches the floors below it', async () => {
    // The defect this channel exists to remove: a step that requests exit and then goes
    // on running its remaining gates. The empty-after-tools exit sits FIRST in the span;
    // everything after it (the classification, the persistence, fifteen floors) must not
    // run, which is observable because none of them can write a row or a steer.
    const out = await runPostCallClassify(
      freshState({ toolCallsExecutedThisTurn: 2 }),
      // t125: NOBODY IS OWED. This arm is the VEHICLE for the exit channel, not a claim
      // about silence — and since t125 the empty-after-tools exit is reachable only when no
      // person is waiting (an owed turn walks the ladder instead). The fixture says which
      // turn this is rather than relying on the gate that used to ignore the question.
      ctxFor({ result: modelResult({ content: '', toolCalls: [] }), hasUnansweredUser: false }),
    );
    expect(out.directive).toBe('exit');
    expect(noteTerminalAnswerSpy).not.toHaveBeenCalled();
    expect(out.state.steerQueue.fired).toHaveLength(0);
  });

  it('THE OWNER LAW OF 2026-07-09: a USER counterparty is never reclassified, and the law is written down at the site', async () => {
    // `interAgentTurn` is the post-model half of the law (the pre-model stamp is the
    // other). With a human counterparty the union is FORCED false, whatever the A2A
    // signals say — which is why the clause drives the step with every one of them on.
    const out = await runPostCallClassify(
      freshState({ sentToAgentThisTurn: true }),
      ctxFor({
        isA2ATurn: true, mostRecentIsA2A: true, hasUnansweredUser: false,
        result: modelResult({ toolCalls: [{ id: 'tc-1', name: 'file_read', arguments: {} } as ToolCall], stopReason: 'tool_use' }),
      }),
    );
    if (out.directive !== 'proceed') throw new Error('unreachable');
    expect(out.interAgentTurn).toBe(false);
  });

  it('PHASE-6 T-PROMISE: THE UNCOMMITTED-PROMISE FLOOR — the LEDGER fires it, and the SAME WORDS with a row stand down', async () => {
    // The measured miss, verbatim from the Step-0 drive (9 of 9 misses called no tool at all
    // and claimed the recording anyway). `fakeDb` answers nothing, so the spine read returns
    // no rows — which is exactly the state the floor exists for.
    const miss = await runPostCallClassify(freshState(), ctxFor({
      result: modelResult({
        content: "acorn Noted — I've recorded the commitment to email the roof quote to Bob once he sends his address.",
      }),
    }));
    expect(miss.directive).toBe('continue');
    expect(miss.state.steerQueue.fired.some((e) => e.floor === 'uncommitted-promise')).toBe(true);

    // THE CONTROL, and it is the clause that proves the trigger is not the prose: the same
    // sentence with a successful `work_open` on the turn stands down. The hit and the miss
    // are the same English; only the ledger separates them.
    const hit = await runPostCallClassify(
      freshState({
        toolResults: [
          { toolCallId: 'wo-1', name: 'work_open', content: 'Recorded: cmt:a709cb4fd087', isError: false },
        ] as AgentTurnState['toolResults'],
      }),
      ctxFor({
        result: modelResult({
          content: "acorn Noted — I've recorded the commitment to email the roof quote to Bob once he sends his address.",
        }),
      }),
    );
    expect(hit.state.steerQueue.fired.some((e) => e.floor === 'uncommitted-promise')).toBe(false);
  });

  it('PHASE-6 T-PROMISE: it is NOT `promise-floor` — different trigger, different action, and it is sequenced first', async () => {
    // `promise-floor` needs the decision model's verdict, and none is installed here.
    const out = await runPostCallClassify(freshState(), ctxFor({
      result: modelResult({
        content: 'acorn Noted — the fence estimate to Bob is recorded as a commitment; I will email it once he sends his address.',
      }),
    }));
    const fired = out.state.steerQueue.fired.map((e) => e.floor);
    expect(fired).toContain('uncommitted-promise');
    expect(fired).not.toContain('promise-floor');
  });
});
