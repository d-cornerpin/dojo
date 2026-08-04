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
//     (`continuationContext` is stashed by one turn expressly FOR the next one;
//     `untrackedWorkAcrossTurns` exists because a per-turn counter resetting every
//     turn WAS the defect). `drainHead`'s retirement into `drain_state` (migration
//     140, "A Map dies with the process") is the shape those follow — not this one.
//   * THAT THE TEN MAPS ARE GONE rather than standing beside their replacement,
//     which is the disease this overhaul exists to remove.
// ════════════════════════════════════════════════════════════════════════════════

import { describe, it, expect, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import {
  openTurnContext, turnContext, endTurnContext, turnConversationScope,
  getWorkOriginForAgent, noteTurnReceipt, getTurnReceipts,
  getRecallBudgetUsed, addRecallBudgetUsed, openTurnContextAgents,
} from '../turn-context.js';

import {
  turnBoundary, continuationContext, forceA2ATurn, a2aTurnRetries,
  untrackedWorkAcrossTurns, lastTurnWasA2A,
} from '../turn-state.js';
import {
  activeRuns, pendingWakeups, stoppedAgents, activeAbortControllers, preemptedAgents,
  backgroundDrains, lastCompactionDividerAt, lastA2APreemptAt, agentStartTimes,
  turnContinuationCounts, statusHeartbeats, recoveryRunStreak,
} from '../shared-state.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.resolve(HERE, '..', '..');
const REPO = path.resolve(SRC, '..', '..', '..');
const read = (p: string): string => readFileSync(path.join(SRC, p), 'utf8');

/** The ten facts the turn owns. Adding an eleventh is a decision: it belongs here
 *  only if it dies with the turn, and the clause below makes that decision visible. */
const THE_TURN_OWNS = [
  'agentId',
  'kind', 'convKey', 'conversationId', 'imRecipient', 'modelRequestId',
  'turnNumber', 'root', 'servedWork', 'receiptIds', 'recallTokens',
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
  // Migrated with a MEASUREMENT rather than a hazard: it has no reader anywhere, and a
  // relocation does not get to retire a flag. See the field's own comment.
  'modelCallInFlight',
  'ownerAffinityConversationId',
  'ownerAffinityDestination',
  'deferredUserReplyWithTools',
  'turnInjectedTechniqueId',
  // PHASE-6 T4 (CUT 6) — the `assemble` tranche's crossings. The assembler-bookkeeping
  // trio is the family whose by-value alternative is measurably WRONG in three
  // different ways: the stamp dies at the boundary, the overhead never reaches the next
  // iteration's gate, and the once-per-TURN banner latch resets every round.
  'lastAssembledAtIso',
  'assemblerOverheadTokens',
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
  // Same tranche, second family: the once-per-turn filler latch. All four of its sites are
  // inside the span, so it crosses the ITERATION rather than a step — and a step-local would
  // be reset every round, so the caller hears "on it … checking … give me a sec …" in a row.
  'voiceFillerFired',
];

/** The six in `turn-state.ts` that OUTLIVE the turn on purpose. */
const TURN_STATE_KEEPS = [
  'turnBoundary', 'continuationContext', 'forceA2ATurn', 'a2aTurnRetries',
  'untrackedWorkAcrossTurns', 'lastTurnWasA2A',
];

/** The names the collapse RETIRED from `turn-state.ts`. Grep-zero with a denominator:
 *  the plan's own exit gate warns that a grep over one file passes while half the
 *  surface stands, so the clause names all ten and the file must declare none. */
const RETIRED_FROM_TURN_STATE = [
  'currentTurnKind', 'currentTurnConvKey', 'currentTurnConversationId',
  'currentTurnImRecipient', 'currentModelRequestId', 'currentTurnReceipts',
  'currentTurnNumber', 'currentTurnRecallTokens', 'currentTurnRoot',
  'currentTurnServedWork',
];

beforeEach(() => {
  for (const a of openTurnContextAgents()) endTurnContext(a);
});

describe('PHASE-6 T1: TurnContext — what the turn owns', () => {
  it('CENSUS: the bag holds exactly the classified fields and nothing else', () => {
    const ctx = openTurnContext('kevin');
    expect(Object.keys(ctx).sort()).toEqual([...THE_TURN_OWNS, ...THE_DRIVER_CARRIES].sort());
  });

  it('the two populations do not overlap, and a carrier is a DRIVER local, not a published fact', () => {
    // The distinction is what keeps population 2 from becoming a back door: a fact the
    // outside reads goes through this module's accessors and is named in the first list;
    // a carrier is driver-internal and is named in the second. A name in both would mean
    // the classification had stopped meaning anything.
    expect(THE_TURN_OWNS.filter((k) => THE_DRIVER_CARRIES.includes(k))).toEqual([]);
    // And the carriers are genuinely unpublished: this module exports no reader for one.
    const bagSrc = read('agent/turn-context.ts');
    for (const carrier of THE_DRIVER_CARRIES) {
      const exportedReaders = [...bagSrc.matchAll(/export function (\w+)/g)]
        .map((m) => m[1])
        .filter((fn) => new RegExp(`${fn}[\\s\\S]{0,400}?\\.${carrier}\\b`).test(bagSrc));
      expect(exportedReaders, `${carrier} is a driver local; nothing outside should read it`).toEqual([]);
    }
  });

  it('a fresh bag starts empty — which is why no turn-entry clear survives', () => {
    const first = openTurnContext('kevin');
    first.kind = 'a2a';
    first.turnNumber = 41;
    noteTurnReceipt('kevin', 'r1');
    addRecallBudgetUsed('kevin', 900);

    const second = openTurnContext('kevin');
    expect(second).not.toBe(first);
    expect(second.kind).toBeUndefined();
    expect(second.turnNumber).toBeUndefined();
    expect(getTurnReceipts('kevin')).toEqual([]);
    expect(getRecallBudgetUsed('kevin')).toBe(0);
  });

  it('ONE CLEAR POINT: endTurnContext removes the bag, and reads answer "outside a turn"', () => {
    const ctx = openTurnContext('kevin');
    ctx.root = { kind: 'ask', id: 'msg-1', sourceMessageId: 'msg-1', conversationId: 'conv-1' };
    ctx.turnNumber = 7;
    ctx.convKey = 'ck';
    expect(turnContext('kevin')).toBeDefined();

    endTurnContext('kevin');

    expect(turnContext('kevin')).toBeUndefined();
    expect(openTurnContextAgents()).not.toContain('kevin');
    expect(getWorkOriginForAgent('kevin', 'model'))
      .toEqual({ kind: 'model', sourceMessageId: null, turn: null, convKey: null });
  });

  it('THE THREE-STATE CONTRACT SURVIVES: no bag / explicit null / a conversation', () => {
    // E-C1's contract, and flattening it is what bled an unrelated human conversation
    // into recall on engine/A2A turns. `undefined` = outside a turn (fall back to the
    // legacy heuristic), `null` = engine/A2A turn, a string = scope to it.
    expect(turnConversationScope('kevin')).toBeUndefined();

    const ctx = openTurnContext('kevin');
    expect(turnConversationScope('kevin')).toBeUndefined();   // published nothing yet

    ctx.conversationId = null;
    expect(turnConversationScope('kevin')).toBeNull();

    ctx.conversationId = 'conv-1';
    expect(turnConversationScope('kevin')).toBe('conv-1');
  });

  it('one agent\'s bag is not another\'s', () => {
    const kevin = openTurnContext('kevin');
    kevin.kind = 'user';
    openTurnContext('kelly');
    expect(turnContext('kelly')!.kind).toBeUndefined();
    endTurnContext('kelly');
    expect(turnContext('kevin')!.kind).toBe('user');
  });

  it('outside a turn, per-turn recorders record nothing rather than a stale entry', () => {
    // The old maps created an entry lazily for an agent that was not in a turn (a tool
    // driven for a peer through the a2a transport does exactly this), and that entry
    // then survived until whenever that agent next went idle. Answering "no turn" is the
    // same answer `turnNumber` already gave for the same call.
    noteTurnReceipt('nobody', 'r1');
    expect(getTurnReceipts('nobody')).toEqual([]);
    expect(addRecallBudgetUsed('nobody', 500)).toBe(0);
    expect(getRecallBudgetUsed('nobody')).toBe(0);
    expect(openTurnContextAgents()).toEqual([]);
  });
});

describe('PHASE-6 T1: the other direction — what must NOT be in the bag', () => {
  it('the eighteen CROSS-TURN carriers survive endTurnContext', () => {
    const A = 'kevin';
    openTurnContext(A);

    // Six that live in `turn-state.ts` on purpose.
    turnBoundary.set(A, '2026-08-04 00:00:00');
    continuationContext.set(A, { convKey: 'ck', conversationId: 'conv-1', counterparty: {} as never });
    forceA2ATurn.add(A);
    a2aTurnRetries.set(A, 1);
    untrackedWorkAcrossTurns.set(A, { convKey: 'ck', count: 3 });
    lastTurnWasA2A.add(A);

    // Twelve that live in `shared-state.ts`, shared with the v1 runtime.
    activeRuns.add(A);
    pendingWakeups.add(A);
    stoppedAgents.add(A);
    activeAbortControllers.set(A, new AbortController());
    preemptedAgents.add(A);
    backgroundDrains.add(A);
    lastCompactionDividerAt.set(A, 1);
    lastA2APreemptAt.set(A, 2);
    agentStartTimes.set(A, 3);
    turnContinuationCounts.set(A, 4);
    statusHeartbeats.set(A, 0 as unknown as ReturnType<typeof setInterval>);
    recoveryRunStreak.set(A, { kind: 'k', inputsFingerprint: 'f', count: 1 });

    endTurnContext(A);

    // THE CLAUSE: the turn's bag is gone and every one of the eighteen is still there.
    // A collapse that swept these in would delete a continuation the NEXT turn is meant
    // to consume, reset a counter whose whole purpose is to cross turns, and drop an
    // abort controller mid-flight.
    expect(turnContext(A)).toBeUndefined();
    const survivors = {
      turnBoundary: turnBoundary.has(A),
      continuationContext: continuationContext.has(A),
      forceA2ATurn: forceA2ATurn.has(A),
      a2aTurnRetries: a2aTurnRetries.has(A),
      untrackedWorkAcrossTurns: untrackedWorkAcrossTurns.has(A),
      lastTurnWasA2A: lastTurnWasA2A.has(A),
      activeRuns: activeRuns.has(A),
      pendingWakeups: pendingWakeups.has(A),
      stoppedAgents: stoppedAgents.has(A),
      activeAbortControllers: activeAbortControllers.has(A),
      preemptedAgents: preemptedAgents.has(A),
      backgroundDrains: backgroundDrains.has(A),
      lastCompactionDividerAt: lastCompactionDividerAt.has(A),
      lastA2APreemptAt: lastA2APreemptAt.has(A),
      agentStartTimes: agentStartTimes.has(A),
      turnContinuationCounts: turnContinuationCounts.has(A),
      statusHeartbeats: statusHeartbeats.has(A),
      recoveryRunStreak: recoveryRunStreak.has(A),
    };
    expect(Object.entries(survivors).filter(([, v]) => !v).map(([k]) => k)).toEqual([]);
    expect(Object.keys(survivors)).toHaveLength(18);

    for (const m of [turnBoundary, continuationContext, a2aTurnRetries, untrackedWorkAcrossTurns,
      activeAbortControllers, lastCompactionDividerAt, lastA2APreemptAt, agentStartTimes,
      turnContinuationCounts, statusHeartbeats, recoveryRunStreak]) m.delete(A);
    for (const s of [forceA2ATurn, lastTurnWasA2A, activeRuns, pendingWakeups, stoppedAgents,
      preemptedAgents, backgroundDrains]) s.delete(A);
  });
});

describe('PHASE-6 T1: the ten maps are GONE, not standing beside their replacement', () => {
  it('turn-state.ts declares none of the ten retired per-turn maps', () => {
    const src = read('agent/turn-state.ts');
    const still = RETIRED_FROM_TURN_STATE.filter((n) => new RegExp(`export const ${n}\\b`).test(src));
    expect(still).toEqual([]);
  });

  it('turn-state.ts declares exactly the six cross-turn carriers', () => {
    const src = read('agent/turn-state.ts');
    const declared = [...src.matchAll(/export const (\w+) = new (?:Map|Set)/g)].map((m) => m[1]);
    expect(declared.sort()).toEqual([...TURN_STATE_KEEPS].sort());
  });

  it('shared-state.ts still declares its twelve, untouched by this task', () => {
    const src = read('agent/shared-state.ts');
    const declared = [...src.matchAll(/export const (\w+) = new (?:Map|Set)/g)].map((m) => m[1]);
    expect(declared).toHaveLength(12);
  });

  it('the two ambient-state files are PINNED in ratchets.json', () => {
    // RE-DERIVED #8: neither was watched, so the collapse target could have grown
    // unnoticed. A pin is what makes "only shrinks from here" a machine fact.
    const ratchets = JSON.parse(readFileSync(path.join(REPO, 'ratchets.json'), 'utf8')) as
      { files: Record<string, number> };
    expect(ratchets.files['packages/server/src/agent/turn-state.ts']).toBeGreaterThan(0);
    expect(ratchets.files['packages/server/src/agent/shared-state.ts']).toBeGreaterThan(0);
    expect(ratchets.files['packages/server/src/agent/turn-context.ts']).toBeGreaterThan(0);
  });
});
