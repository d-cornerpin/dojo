// ════════════════════════════════════════════════════════════════════════════════
// PHASE-6 T1 — THE BAG'S CONTRACT, AND THE OTHER DIRECTION.
//
// The behavioural half of this task lives in `agent/v2/__tests__/integration.test.ts`
// (the four teardown reads, the `break` and `return` exits, the leak on the error
// path) — those clauses drive real turns and fail on the defect. This file holds the
// half that a driven turn cannot show:
//
//   * WHAT IS IN THE BAG, by name, so a fact added later must be classified rather
//     than drift in;
//   * WHAT IS NOT, and survives the clear — the plan's explicit warning that a
//     careless collapse sweeps the CROSS-TURN state into an object emptied in
//     `finally` and thereby deletes the state that is supposed to outlive the turn
//     (`untrackedWorkAcrossTurns` exists because a per-turn counter resetting every
//     turn WAS the defect). `drainHead`'s retirement into `drain_state` (migration
//     140, "A Map dies with the process") is the shape those follow — not this one.
//   * THAT THE TEN MAPS ARE GONE rather than standing beside their replacement,
//     which is the disease this overhaul exists to remove.
// ════════════════════════════════════════════════════════════════════════════════

import { describe, it, expect, beforeEach } from 'vitest';

import {
  openTurnContext, turnContext, endTurnContext, turnConversationScope,
  getWorkOriginForAgent, openTurnContextAgents,
} from '../turn-context.js';

import {
  turnBoundary, untrackedWorkAcrossTurns,
} from '../turn-state.js';
import {
  activeRuns, pendingWakeups, stoppedAgents, activeAbortControllers, preemptedAgents,
  backgroundDrains, lastCompactionDividerAt, lastA2APreemptAt, agentStartTimes,
  statusHeartbeats, recoveryRunStreak,
} from '../shared-state.js';
import { FXID } from '../../../../../deploy/checks/fixture-vocabulary.mjs';

/** The ten facts the turn owns. Adding an eleventh is a decision: it belongs here
 *  only if it dies with the turn, and the clause below makes that decision visible. */
const THE_TURN_OWNS = [
  'agentId',
  'kind', 'convKey', 'conversationId', 'modelRequestId',
  'address',   // 3.5: who this turn talks to and where the reply lands; computed once in preflight, read by delivery, the assembler and the send tools
  'turnNumber', 'root', 'servedWork', 'triggerMessageId',
  'pickupSeq',   // t145: the message-sequence high-water at pickup, read by the delegate-reply link (tracker-store)
  'jobParked',   // the task `parkJob` (work/) parked the job on, read by `turnParkedTheJob` and finalize: a published fact
  'servedJob',   // the task a job's own turn was started from (the preflight's pickup); the job's readers and finalize read it
];

/** POPULATION 2 — mutable DRIVER locals that cross a step boundary, carried here
 *  under RULING P6-R3(1) ("the carrier is the turn's bag … and no second mechanism")
 *  as PHASE-6 extracts the driver into step packages.
 *
 *  ⚠ THE CENSUS BELOW DELIBERATELY STAYS CLOSED, and this list is why it can be. The
 *  clause's job was never "the bag has exactly ten keys" — it is "a field added later
 *  must be CLASSIFIED rather than drift in", which is this file's own opening comment.
 *  A carrier earns a line here only when the extraction that needs it lands, with the
 *  tranche named; a field that is neither a fact the outside reads nor a named
 *  crossing still fails, exactly as before. It was T9b's own suite run that caught the
 *  addition, which is the clause working rather than the clause being in the way. */
const THE_DRIVER_CARRIES = [
  'startAckTimer', // PHASE-6 T9b — the F10 timer handle; read AND written by the teardown span
  // PHASE-6 T9 (CUT 4) — the `finalize` tranche's crossings. The phone-stream pair is
  // the one family whose by-value alternative is measurably UNSAFE (written from the
  // model's onChunk CALLBACK, and the buffer is WRITTEN by the span); the rest cross
  // under RULING P6-R3(1)'s rule rather than under a hazard, and each field says which.
  'phoneStreamBuffer',
  'phoneStreamFlushedAny',
  // PHASE-6 T5 (CUT 5) — the `callLLM` tranche's crossings. The phone-stream family is
  // COMPLETED here: its third local crosses this span and the next one, which is exactly
  // what CUT 4's deferral note said would happen.
  'phoneStreamCallSid',
  // The spin-brake pair is split across the `execute` and `callLLM` spans in OPPOSITE
  // directions, so it is the one family here that by value would be wrong twice over.
  'toolPhaseEndedBySpinBrake',
  'spinBrakeGraceCalls',
  'mediaWordsStepOwed',   // proof-fix K: set by `execute` after a generator, read by `execute` and its tool door on the next iteration
  'ownerAffinityConversationId',
  'ownerAffinityDestination',
  'deferredUserReplyWithTools',
  // t202 (A2) — the id of the note the seam wrote for the text above; written in the post-call
  // seam, read once by finalize's recovery. Same crossing, same rule as its sibling.
  'deferredNoteId',
  // PHASE-6 T4 (CUT 6) — the `assemble` tranche's crossings. The assembler-bookkeeping
  // trio is the family whose by-value alternative is measurably WRONG in three
  // different ways: the stamp dies at the boundary, the overhead never reaches the next
  // iteration's gate, and the once-per-TURN banner latch resets every round.
  'lastAssembledAtIso',
  'freshTailDropWarned',
  // The F10 start-ack steer's four locals are ONE mechanism split across FOUR spans,
  // and the request flag is written from the wall-clock TIMER — the by-value test's
  // own disqualifier, and T2's named live-read case in the tree's own words.
  'startAckSteerRequested',
  'startAckSteerArmedThisTurn',
  'startAckSteersInjected',
  'startAckSteerInjectedAtLoop',
  // Written once, straight-line, INSIDE the span and read by `postCallClassify` — the
  // silent direction is that a ghosted work ask reads as chatter and never steers.
  'inboundClassifiedAsWork',
  // PHASE-6 T7 (CUT 7) — the `execute` tranche's ONE written crossing, and it COMPLETES
  // the F10 family above. Written at the first tool dispatch, READ from the wall-clock
  // timer callback: by value the timer reads `false` forever and a long working turn
  // takes the "chat-shaped, stay quiet" branch, so the waiting person hears nothing.
  'anyToolStartedThisTurn',
  // PHASE-6 T6 (CUT 8) — the `postCallClassify` tranche's ack-delivery pair, and the FIFTH
  // and SIXTH locals of the same F10 mechanism. `engineStartAckDeliveredThisTurn` is READ
  // inside the wall-clock timer callback that decides whether to fire an ack at all, so by
  // value the timer reads `false` after the ack was delivered and the person is acked TWICE.
  // `deferredDeliveredByAck` is written beside it and gates the terminal promotion and the
  // redundant-closeout floor, so a lost write double-SENDS the answer.
  'engineStartAckDeliveredThisTurn',
  'deferredDeliveredByAck',
  // ANSWER-ANYWAY — the SEVENTH local of the same F10 mechanism, and it is classified here
  // rather than drifting in. The pair above records THAT the ack lane spoke; this records
  // WHICH bubble carried the words, which is what the `[no-reply]` reply rule needs to name
  // the turn's answer when the promotion delivered it. Written in `postCallClassify` and read
  // by a LATER ITERATION of the same span (the promotion rides with a tool call; the sentinel
  // arrives after the tools have run), so a step-local resets each round and the answer is
  // nameless on every turn that promoted — which is the measured defect, not a hypothesis.
  'startAckPromotedRowId',
  // The queued row of an answer delivered mid-turn: written by the start-ack closure, read by finalize,
  // so it crosses the whole span; finalize does not queue the same words again while it is set.
  'earlyAnswerRowId',
  // The files shown with the reply: written where the files are drained, read by finalize's router.
  'replyFiles',
  // Same tranche, second family: the once-per-turn filler latch. All four of its sites are
  // inside the span, so it crosses the ITERATION rather than a step — and a step-local would
  // be reset every round, so the caller hears "on it … checking … give me a sec …" in a row.
  'voiceFillerFired',
  // Same tranche, third family: "the going-idle detector ran". Also an ITERATION crossing,
  // and the branch that reads it is the one that deliberately does NOT steer — so a reset
  // latch produces an EXTRA engine nudge on a turn that was already nudged.
  'goingIdleDetectorRanThisTurn',
  // The provider's reset the last call met (recovery writes it, finalize reads it) and the no-answer abort mark:
  // both cross from the model call to the turn's end.
  'retryAt',
  'abortHandBack',
  // Another agent's request the preflight picked: the send door and the served ids read it, finalize marks it served.
  'servedRequest',
  // The required reply: armed in the loop's exit, read by the gates, the model call, the empty ladder and finalize.
  'forcedReplySpent',
  'forceReplyPending',
  // Why this turn's push is held: written by the closeout floors, read by finalize's router.
  'pushHeld',
  // PHASE-6 T2 (CUT 9) — the LAST tranche's one written crossing, and the crossing the
  // ruling was written about. T2 handed this span back rather than guess: seven closures
  // declared in `preflight` read live crossing mutable state. Eight cuts drained six of
  // them; the seventh is what they all read THROUGH. Three still read it live, each a
  // guard with its incident at its own site — the wall-clock start-ack timer (by value it
  // acks a person who was already answered), the stranded-ask re-arm (by value every abort
  // looks like a clean retry, so an ask is re-served AFTER the side effect), and the
  // engine-event revert (the same counter, the other half). See the field's own comment.
  'state',
];

beforeEach(() => {
  for (const a of openTurnContextAgents()) endTurnContext(a);
});

describe('PHASE-6 T1: TurnContext — what the turn owns', () => {
  it('CENSUS: the bag holds exactly the classified fields and nothing else', () => {
    const ctx = openTurnContext(FXID.n4);
    expect(Object.keys(ctx).sort()).toEqual([...THE_TURN_OWNS, ...THE_DRIVER_CARRIES].sort());
  });

  it('the two populations do not overlap, and a carrier is a DRIVER local, not a published fact', () => {
    // The distinction is what keeps population 2 from becoming a back door: a fact the
    // outside reads goes through this module's accessors and is named in the first list;
    // a carrier is driver-internal and is named in the second. A name in both would mean
    // the classification had stopped meaning anything.
    expect(THE_TURN_OWNS.filter((k) => THE_DRIVER_CARRIES.includes(k))).toEqual([]);
  });

  it('a fresh bag starts empty — which is why no turn-entry clear survives', () => {
    const first = openTurnContext(FXID.n4);
    first.kind = 'a2a';
    first.turnNumber = 41;

    const second = openTurnContext(FXID.n4);
    expect(second).not.toBe(first);
    expect(second.kind).toBeUndefined();
    expect(second.turnNumber).toBeUndefined();
  });

  it('ONE CLEAR POINT: endTurnContext removes the bag, and reads answer "outside a turn"', () => {
    const ctx = openTurnContext(FXID.n4);
    ctx.root = { kind: 'ask', id: 'msg-1', sourceMessageId: 'msg-1', conversationId: 'conv-1' };
    ctx.turnNumber = 7;
    ctx.convKey = 'ck';
    expect(turnContext(FXID.n4)).toBeDefined();

    endTurnContext(FXID.n4);

    expect(turnContext(FXID.n4)).toBeUndefined();
    expect(openTurnContextAgents()).not.toContain(FXID.n4);
    expect(getWorkOriginForAgent(FXID.n4, 'model'))
      .toEqual({ kind: 'model', sourceMessageId: null, turn: null, convKey: null });
  });

  it('THE THREE-STATE CONTRACT SURVIVES: no bag / explicit null / a conversation', () => {
    // E-C1's contract, and flattening it is what bled an unrelated human conversation
    // into recall on engine/A2A turns. `undefined` = outside a turn (fall back to the
    // legacy heuristic), `null` = engine/A2A turn, a string = scope to it.
    expect(turnConversationScope(FXID.n4)).toBeUndefined();

    const ctx = openTurnContext(FXID.n4);
    expect(turnConversationScope(FXID.n4)).toBeUndefined();   // published nothing yet

    ctx.conversationId = null;
    expect(turnConversationScope(FXID.n4)).toBeNull();

    ctx.conversationId = 'conv-1';
    expect(turnConversationScope(FXID.n4)).toBe('conv-1');
  });

  it('one agent\'s bag is not another\'s', () => {
    const bagN4 = openTurnContext(FXID.n4);
    bagN4.kind = 'user';
    openTurnContext(FXID.n5);
    expect(turnContext(FXID.n5)!.kind).toBeUndefined();
    endTurnContext(FXID.n5);
    expect(turnContext(FXID.n4)!.kind).toBe('user');
  });
});

describe('PHASE-6 T1: the other direction — what must NOT be in the bag', () => {
  it('the thirteen CROSS-TURN carriers survive endTurnContext', () => {
    const A = FXID.n4;
    openTurnContext(A);

    // Two that live in `turn-state.ts` on purpose.
    turnBoundary.set(A, '2026-08-04 00:00:00');
    untrackedWorkAcrossTurns.set(A, { convKey: 'ck', count: 3 });

    // Eleven that live in `shared-state.ts`, shared with the v1 runtime.
    activeRuns.add(A);
    pendingWakeups.add(A);
    stoppedAgents.add(A);
    activeAbortControllers.set(A, new Set([new AbortController()]));
    preemptedAgents.add(A);
    backgroundDrains.add(A);
    lastCompactionDividerAt.set(A, 1);
    lastA2APreemptAt.set(A, 2);
    agentStartTimes.set(A, 3);
    statusHeartbeats.set(A, 0 as unknown as ReturnType<typeof setInterval>);
    recoveryRunStreak.set(A, { kind: 'k', inputsFingerprint: 'f', count: 1 });

    endTurnContext(A);

    // THE CLAUSE: the turn's bag is gone and every one of the thirteen is still there.
    // A collapse that swept these in would reset a counter whose whole purpose is to cross turns, and drop an
    // abort controller mid-flight.
    expect(turnContext(A)).toBeUndefined();
    const survivors = {
      turnBoundary: turnBoundary.has(A),
      untrackedWorkAcrossTurns: untrackedWorkAcrossTurns.has(A),
      activeRuns: activeRuns.has(A),
      pendingWakeups: pendingWakeups.has(A),
      stoppedAgents: stoppedAgents.has(A),
      activeAbortControllers: activeAbortControllers.has(A),
      preemptedAgents: preemptedAgents.has(A),
      backgroundDrains: backgroundDrains.has(A),
      lastCompactionDividerAt: lastCompactionDividerAt.has(A),
      lastA2APreemptAt: lastA2APreemptAt.has(A),
      agentStartTimes: agentStartTimes.has(A),
      statusHeartbeats: statusHeartbeats.has(A),
      recoveryRunStreak: recoveryRunStreak.has(A),
    };
    expect(Object.entries(survivors).filter(([, v]) => !v).map(([k]) => k)).toEqual([]);
    expect(Object.keys(survivors)).toHaveLength(13);

    for (const m of [turnBoundary, untrackedWorkAcrossTurns,
      activeAbortControllers, lastCompactionDividerAt, lastA2APreemptAt, agentStartTimes,
      statusHeartbeats, recoveryRunStreak]) m.delete(A);
    for (const s of [activeRuns, pendingWakeups, stoppedAgents,
      preemptedAgents, backgroundDrains]) s.delete(A);
  });
});
