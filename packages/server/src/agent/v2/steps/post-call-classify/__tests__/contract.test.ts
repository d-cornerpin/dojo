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
import ts from 'typescript';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import type { ToolCall } from '@dojo/shared';
import { advance, initState, type AgentTurnState } from '../../../state.js';
import {
  runPostCallClassify,
  POST_CALL_CLASSIFY_PHASE,
  type PostCallClassifyContext,
} from '../index.js';

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
const persistAndBroadcastSystemRowSpy = vi.fn();
const startAckRepliedNowSpy = vi.fn(() => false);

function turnCtxFor(over: Record<string, unknown> = {}): PostCallClassifyContext['turnCtx'] {
  return {
    agentId: 'kevin',
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
    agentId: 'kevin',
    turnCtx: turnCtxFor(),
    turnNumber: 7,
    db: fakeDb,
    agent: { id: 'kevin', name: 'Kevin' } as unknown as PostCallClassifyContext['agent'],
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
    maxToolLoops: 75,
    reArmIfStrandedNoAnswer: reArmIfStrandedNoAnswerSpy,
    noteTerminalAnswer: noteTerminalAnswerSpy,
    deliverEngineUserAck: deliverEngineUserAckSpy,
    persistAndBroadcastSystemRow: persistAndBroadcastSystemRowSpy,
    startAckRepliedNow: startAckRepliedNowSpy,
    ...over,
  } as PostCallClassifyContext;
}

function freshState(over: Partial<AgentTurnState> = {}): AgentTurnState {
  // The reducer's own constructor, called with its own parameter object rather than
  // positionally: `state.modelId` is one of this step's four outputs, so a state built
  // sloppily would make that output read `undefined` and the clause prove nothing.
  const base = initState({
    agentId: 'kevin', contextWindow: 128_000, isAutoRouted: false,
    configuredModelId: 'test-model', turnNumber: 7, triggeredByIMessage: false,
    triggeredByA2AReplyIntent: null, lastUserMessageContent: 'what is the answer?',
    lastUserMessageId: 'msg-user-1',
  } as Parameters<typeof initState>[0]);
  return advance(base, { phase: POST_CALL_CLASSIFY_PHASE, loopCount: 2, modelId: 'test-model', ...over });
}

beforeEach(() => { vi.clearAllMocks(); });

// ── The step package's own source, for the clauses that are about SHAPE ──
const STEP_DIR = path.resolve(__dirname, '..');
function stepFiles(dir: string = STEP_DIR): string[] {
  const out: string[] = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.isDirectory()) { if (e.name !== '__tests__') out.push(...stepFiles(path.join(dir, e.name))); }
    else if (e.name.endsWith('.ts')) out.push(path.join(dir, e.name));
  }
  return out;
}
const stepText = (): string => stepFiles().map((f) => readFileSync(f, 'utf8')).join('\n');

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
    expect(deliverEngineUserAckSpy).toHaveBeenCalledWith('Here is the answer.', null);
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
      ctxFor({ result: modelResult({ content: '', toolCalls: [] }) }),
    );
    expect(exited.directive).toBe('exit');
    expect(exited.state.phase).toBe(POST_CALL_CLASSIFY_PHASE);

    // ⚠ AND ONE `phase:` WRITE SURVIVES THE MOVE, PINNED HERE RATHER THAN GLOSSED.
    // The duplicate-final-answer prevention (v2.7.2) sets BOTH
    // `taskClosedWithTextThisTurn` and `phase: 'done'`. The first is what actually ends
    // the loop — a set-only flag the `while` head reads, which `steps/step-outcome.ts`
    // names as the surviving workaround this channel replaces. The second is INERT and
    // provably so: the block requires a `complete_task` in `result.toolCalls`, so the
    // step always proceeds, and the driver's own unconditional `advance(state, { phase:
    // 'execute' })` overwrites it before anything reads it. The count is pinned at ONE
    // so a second cannot appear quietly, and the fix rides its own commit.
    expect([...stepText().matchAll(/(?<!\w)phase:\s*'/g)]).toHaveLength(1);
    expect(stepText()).toMatch(/phase: 'done'/);
  });

  it('THE DRIVER ADVANCES INTO IT, at the call site and ahead of the step', () => {
    // `validate()` runs on the transition by construction, because the advance is an
    // `advance` and it is the DRIVER's statement, not the step's.
    const driver = readFileSync(path.resolve(__dirname, '../../../loop.ts'), 'utf8');
    const advanceAt = driver.indexOf("advance(state, { phase: 'postCallClassify' })");
    const callAt = driver.indexOf('runPostCallClassify(state,');
    expect(advanceAt).toBeGreaterThan(-1);
    expect(callAt).toBeGreaterThan(-1);
    expect(advanceAt).toBeLessThan(callAt);
  });

  it('THE EXIT-REQUEST CHANNEL, as a CENSUS WITH A DENOMINATOR: three directives, SEVEN exits, SEVENTEEN continues', () => {
    // Twenty-four conversions — the most of any tranche in the phase, four times
    // `execute`'s six. Every one of them was a `break` or a `continue` of the driver's
    // loop before the cut, so a new silent way out cannot appear without failing here.
    // The walk is over the package's own AST: a directive named in a comment does not
    // count and a real call does.
    const directives = new Set<string>();
    let exitSites = 0;
    let continueSites = 0;
    for (const f of stepFiles()) {
      const sf = ts.createSourceFile(f, readFileSync(f, 'utf8'), ts.ScriptTarget.ESNext, true);
      const walk = (n: ts.Node): void => {
        if (ts.isCallExpression(n) && ts.isIdentifier(n.expression)) {
          const name = n.expression.text;
          if (name === 'proceed') directives.add('proceed');
          if (name === 'continueLoop') { directives.add('continue'); continueSites += 1; }
          if (name === 'requestExit') { directives.add('exit'); exitSites += 1; }
          if (name === 'abandonTurn') directives.add('abandon');
        }
        ts.forEachChild(n, walk);
      };
      walk(sf);
    }
    expect([...directives].sort()).toEqual(['continue', 'exit', 'proceed']);
    // The seven: empty-after-tools · the empty-response give-up · the near-duplicate
    // reply · the A2A missed-reply hardcap · the close-out one-shot · the tracker
    // close-out hardcap · and the plain "no tool calls, the turn is done".
    expect(exitSites).toBe(7);
    // The seventeen re-entries: three in the empty-response ladder and fourteen floors
    // that hand the model one more round to put something right.
    expect(continueSites).toBe(17);
  });

  it('EXIT IS NOT SAYABLE WITHOUT A REASON, and the arms name their own', async () => {
    const afterTools = await runPostCallClassify(
      freshState({ toolCallsExecutedThisTurn: 2 }),
      ctxFor({ result: modelResult({ content: '', toolCalls: [] }) }),
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
      ctxFor({ result: modelResult({ content: '', toolCalls: [] }) }),
    );
    expect(out.directive).toBe('exit');
    expect(persistAndBroadcastSystemRowSpy).not.toHaveBeenCalled();
    expect(noteTerminalAnswerSpy).not.toHaveBeenCalled();
    expect(out.state.steerQueue.fired).toHaveLength(0);
  });

  it('OR2 AT THE STEP: the floor family is AGENT-VOICED — every floor steers the MODEL, none composes a line for the user', () => {
    // The plan's own note for this tranche: "the floor family already runs agent-voiced
    // (Phase 4); this tranche only RELOCATES." The relocation has to KEEP that, and the
    // shape that keeps it is structural: a floor's output goes to the steer queue (a
    // model-visible `role='system'` row), never to an assistant-role row the person reads
    // as the agent. Two halves, so neither can pass on the other's absence.
    const text = stepText();
    // (a) every floor id this span declares still has a real site here — a census with
    //     its own denominator, so a floor silently lost in the move fails loudly.
    const FLOORS = [
      'empty-response', 'ungrounded-claim', 'delivery-denial', 'failed-save-claim',
      'silent-closeout', 'add-notes-stop', 'going-idle-in-progress', 'owed-interrupt',
      'promise-floor', 'a2a-handoff-floor', 'reminder-silence', 'ghosted-ask',
      'ghosted-ask-answer', 'a2a-missed-reply', 'tracker-closeout',
    ];
    for (const f of FLOORS) expect(text).toContain(`'${f}'`);
    // (b) the package writes no assistant-role message of its own composing. The one
    //     assistant row it persists is the MODEL's own text, and it goes through the
    //     driver's own capture site rather than being composed here.
    const composed = [...text.matchAll(/role:\s*'assistant'/g)].length;
    expect(composed).toBeGreaterThan(0);              // the model's own text IS persisted here
    expect(text).not.toMatch(/role:\s*'assistant'[\s\S]{0,200}?content:\s*['"`]\[?(System|Engine)/);
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
    // …and the reason is at the site, so a future editor is told why it is floored.
    expect(stepText()).toMatch(/USER TURNS ARE NEVER RECLASSIFIED/);
  });

  it('THE DOCUMENTED LANDMINE: neither signature function follows the code into this package', () => {
    // `identicalCallSignature` and `canonicalToolSignature` STAY DISTINCT (Global
    // Constraints). Both live in `steps/execute/`; a second home here is how one edit
    // would start moving two thresholds, so the absence is asserted rather than assumed.
    const text = stepText();
    expect(text).not.toMatch(/identicalCallSignature/);
    expect(text).not.toMatch(/canonicalToolSignature/);
  });

  it('THRESHOLDS COPIED VERBATIM — the numbers this span decides on are the same numbers', () => {
    const text = stepText();
    // The empty-response ladder: silent retry once, then the nudge, then the toast.
    expect(text).toMatch(/retriedEmptyResponse/);
    // The redundant-closeout floor's own character bound and the floor-steer cap.
    expect(text).toMatch(/REDUNDANT_CLOSEOUT_MAX_CHARS/);
    expect(text).toMatch(/MAX_FLOOR_STEER_ATTEMPTS/);
    // The proactive-send backoff's demote threshold.
    expect(text).toMatch(/PROACTIVE_SEND_DEMOTE_THRESHOLD/);
  });

  it('THE RC-13.2 SAVE-CLAIM FLOOR SURVIVES THE MOVE WITH ITS THREE-PART CONDITION INTACT', async () => {
    // Step 1a landed this guard's end-to-end clauses GREEN on the unmoved tree, because
    // it had no test anywhere in either repo. This is the unit-level echo: the condition
    // that decides it is still all three parts and not two.
    const out = await runPostCallClassify(
      freshState({
        toolResults: [
          { toolCallId: 'vr-1', name: 'vault_remember', content: 'REJECTED', isError: true },
        ] as AgentTurnState['toolResults'],
      }),
      ctxFor({ result: modelResult({ content: 'Saved that for you.' }) }),
    );
    expect(out.directive).toBe('continue');
    expect(out.state.steerQueue.fired.some((e) => e.floor === 'failed-save-claim')).toBe(true);

    // …and the arm that must stay quiet: something WAS stored, so the claim is not a lie.
    const quiet = await runPostCallClassify(
      freshState({
        toolResults: [
          { toolCallId: 'vr-1', name: 'vault_remember', content: 'REJECTED', isError: true },
          { toolCallId: 'vr-2', name: 'vault_remember', content: 'stored', isError: false },
        ] as AgentTurnState['toolResults'],
      }),
      ctxFor({ result: modelResult({ content: 'Saved that for you.' }) }),
    );
    expect(quiet.state.steerQueue.fired.some((e) => e.floor === 'failed-save-claim')).toBe(false);
  });

  it('THE SHARED CONTRACT IS REUSED UNCHANGED — no private directive was invented here', () => {
    const outcome = readFileSync(path.resolve(__dirname, '../../step-outcome.ts'), 'utf8');
    // The vocabulary is the shared one, and this package imports it rather than
    // re-declaring a directive of its own.
    expect(outcome).toMatch(/export type StepDirective = 'proceed' \| 'continue' \| 'exit' \| 'abandon'/);
    expect(stepText()).toMatch(/from '\.\.\/step-outcome\.js'|from '\.\.\/\.\.\/step-outcome\.js'/);
    expect(stepText()).not.toMatch(/type\s+\w*Directive\s*=/);
  });
});
