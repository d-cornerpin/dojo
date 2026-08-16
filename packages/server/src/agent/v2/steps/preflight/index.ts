// ════════════════════════════════════════
// PHASE-6 T2 (CUT 9) — THE `preflight` STEP. RULING P6-R1: a step is a DIRECTORY with
// one entry point; this is it. CUT 9 in the ordinal order (P6-R3(3)) — the LAST
// tranche, and the one the ordering ruling was written to defer.
//
// WHAT MOVED: `loop.ts`'s `preflight` span — everything the turn decides before its
// main `try` opens. The agent and its model, the waiting set and the pickup claim,
// what kind of turn this is, who it is addressing, the turn record and the STATE
// itself, the eight closures the later steps call, the F10 start-ack timer, the
// pre-turn close-out gate, the post-compaction recall flag, and the three step
// contexts.
//
// ── WHAT THIS STEP IS ALONE IN OWING, and each is in the contract test ──
//   • IT IS THE ONE STEP THAT DOES NOT TAKE `state`, BECAUSE IT MAKES IT. Its
//     signature is `(turnCtx, ctx)`. Every other step takes `(state, ctx)`; inventing
//     a state to satisfy that signature would be a lie the type system then carries.
//   • IT PUBLISHES THE STATE TO THE BAG rather than returning it. Three closures this
//     span declares read `state` LIVE — `startAckRepliedNow` from a wall-clock TIMER,
//     `reArmIfStrandedNoAnswer` and `revertTriggerStampOnAbort` at abort time — and a
//     returned value is a snapshot. That is this tranche's carrier (RULING P6-R3(1)),
//     landed at `2252bc6` before a line of this package existed.
//   • IT SEEDS ITS OWN PHASE. `'preflight'` has been a member of `TurnPhase` since the
//     union existed, and it is the one phase no call site advances INTO, because
//     `initState` sets it. The shared rule — the driver advances ahead of the call so
//     `validate()` runs on the transition — is met here by CONSTRUCTION rather than by
//     a call site, which is a property to state rather than paper over.
//   • ITS EXIT CHANNEL IS `abandon` AND NOTHING ELSE. There is no loop yet to leave
//     and the main `try` has not opened, so an abandon means neither finalize nor the
//     teardown `finally` runs — exactly what the two bare `return`s it replaces did.
//     Both are the same shape: another process claimed this turn's trigger.
//
// ── WHY NINE FILES, AND WHY THESE NINE ──
// 1,603 lines against a 400-line `maxNewFileLines`, so the package could not be one
// file and P6-R1's directory shape is NECESSARY here rather than merely permitted.
// The seams are the ones the block already had, measured before the cut: every
// section is under the cap before its header, and the section boundaries are the
// blank lines and banner comments that were already there. ONE of them is
// load-bearing rather than cosmetic — `conversation-identity-is-the-fk` pins an ORDER
// PAIR whose two halves must live in ONE file, and `turn-trigger.ts` holds both by
// construction.
// ════════════════════════════════════════

import type { Database } from 'better-sqlite3';
import type { AgentStatus, DisplayKind } from '@dojo/shared';
import type { TurnContext } from '../../../turn-context.js';
import type { InboundChannel } from '../../inbound-channel.js';
import type { TurnCounterparty, WaitingConversation } from '../../counterparty.js';
import type { UnrepliedAssign } from '../../../a2a-replies.js';
import type { RepeatCallState } from '../../identical-call-brake.js';
import { preflightProceed, type PreflightOutcome } from '../step-outcome.js';
import { runTurnTrigger } from './turn-trigger.js';
import { runInboundAndAbort } from './inbound-and-abort.js';
import { runTurnClassification } from './turn-classification.js';
import { runCounterpartyAndRecord } from './counterparty-and-record.js';
import { runTurnClosures } from './turn-closures.js';
import { runStartAck } from './start-ack.js';
import { runCloseoutGate } from './closeout-gate.js';
import { runCompileGate } from './compile-gate.js';
import { runRecallFlag } from './recall-flag.js';
import { runStepContexts } from './step-contexts.js';
import type { StepContextsOutputs } from './step-contexts.js';

/**
 * The phase this step runs in — and the ONE phase the driver does not advance into,
 * because `initState` seeds it (`state.ts`). Exported for the same reason every other
 * step exports its own: the value belongs to the step, not to a string literal
 * repeated at a call site.
 */
export const PREFLIGHT_PHASE = 'preflight' as const;

/**
 * Everything this step needs that does NOT come from inside its own span. It is
 * short on purpose: the span declares the turn's entire mutable universe, so almost
 * nothing crosses INTO it (the binder census: ZERO crossing-in declarations).
 *
 * The five function members are PASSED rather than imported, each after measuring its
 * readers OUTSIDE the span first. `setAgentStatus` has three and cannot move; the
 * other four measure zero and could have moved, and are passed anyway because they
 * are the status machinery's other half and it stays whole beside the one member that
 * cannot — which also keeps the rule a step never points back at the driver (CUT 2/3's
 * precedent). The two constants are `loop.ts` module-level declarations with readers
 * outside this span, so one declaration is handed across rather than copied (CUT 6's
 * `STALE_TASK_WINDOW_MINUTES` shape).
 */
export interface PreflightContext {
  readonly agentId: string;
  readonly setAgentStatus: (agentId: string, status: AgentStatus) => void;
  readonly startStatusHeartbeat: (agentId: string) => void;
  readonly stopStatusHeartbeat: (agentId: string) => void;
  readonly detectTaskThrashing: (agentId: string) => { thrashing: boolean; toolName?: string; signature?: string; count?: number };
  readonly engineBlockEscapeHatch: string;
  readonly engineStartAckAfterMs: number;
}

/**
 * The THREE locals of this span that cross a sub-module boundary MUTABLY — measured,
 * not guessed, and they are the only three. This is NOT a second carrier mechanism
 * under RULING P6-R3(1): nothing here crosses a STEP boundary. It is one step
 * package's own scratch, created and consumed inside a single call to `runPreflight`
 * — CUT 7's `ExecuteScratch` shape.
 */
export interface PreflightScratch {
  /** D8: set at the engine-event pickup in §4 when THIS turn wins the CAS. Read back
   *  in §2's abort revert, which reverts exactly what this turn took. */
  claimedEngineEvent: { rowid: number; turnNumber: number } | null;
  /** PHASE-2 T9: the event this turn INTENDS to claim, decided at engine-turn
   *  detection in §3. It becomes `claimedEngineEvent` only when the CAS at
   *  turn-identity allocation wins. */
  pendingEngineClaim: { rowid: number } | null;
  /** The TRUTHFUL answer key (2026-07-22 silent-completion root fix): set ONLY at the
   *  persists that genuinely deliver a user-facing reply (the terminal persist, the
   *  G-SUP-2 recovery, the attachment surfacing nets), NEVER at acks, working notes,
   *  or chip echoes. Turn finalize keys `outcome='answered'` and `answer_message_id`
   *  on THIS, replacing the old any-text-row SELECT that counted mid-turn captions as
   *  answers (which stamped asks answered, muted the completion ack, and inflated
   *  ticket stamps). §5 owns its ONE setter; §9's `teardownContext` reads it LIVE. */
  terminalAnswerRowId: string | null;
}

/**
 * What the rest of the turn reads from this span: FORTY-SEVEN declarations, which is
 * the binder census's own figure at this tranche's base, not a hand list. Of them one
 * was mutable (`latestTtsEngine`, two write sites both inside this span and both
 * before the loop opens, so it rides by value as an output on positive evidence, #15)
 * and NONE is written by anything outside the span — the end state RULING P6-R3(1)
 * was aiming at, reached family by family across nine cuts.
 *
 * Every type here is the one the checker already inferred at the declaration inside
 * `runV2TurnBody`. Nothing was widened or re-spelled: a relocation that re-types a
 * value is not a relocation.
 */
export interface PreflightOutputs {
  // §1 — the turn's trigger.
  readonly db: Database;
  readonly agent: Record<string, unknown>;
  readonly configuredModelId: string;
  readonly isAutoRouted: boolean;
  readonly contextModelId: string;
  readonly contextWindow: number;
  readonly waitingConvs: WaitingConversation[];
  readonly isHumanContinuation: boolean;
  readonly chosenConvKey: string;
  readonly triggerRow: WaitingConversation['latest'];
  readonly lastUserMessageContent: string;
  readonly triggerWorkId: string | null;
  readonly triggerConversationId: string | null;
  // §2 — the inbound channel, and the abort revert.
  readonly revertTriggerStampOnAbort: () => void;
  readonly latestUserSource: 'voice' | 'text' | null;
  readonly latestTtsEngine: 'local' | 'cloud' | null;
  readonly inboundChannel: InboundChannel;
  readonly unrepliedAssign: UnrepliedAssign | null;
  // §3 — what kind of turn this is.
  readonly mostRecentInbound: {
    rowid: number; content: string; lane: string; origin_intent: string | null;
    source_agent_id: string | null; a2a_thread_id: string | null; a2a_intent: string | null;
    a2a_requires_response: number | null; inbound_meta: string | null; served_by_turn: number | null;
  } | undefined;
  readonly mostRecentIsA2A: boolean;
  readonly hasUnansweredUser: boolean;
  readonly isA2ATurn: boolean;
  readonly pendingEngineEvent: { rowid: number; id: string; taskId: string | null; runId: string | null; content: string; originIntent: string | null } | null;
  readonly isEngineTurn: boolean;
  readonly settledContextWakeTurn: boolean;
  readonly isNotificationTurn: boolean;
  readonly a2aReplyContext: { intent: string; threadShort: string; fromName: string } | null;
  readonly a2aReplyAssignMessageId: string | null;
  // §4 — the counterparty and the turn record.
  readonly counterparty: TurnCounterparty;
  readonly turnNumber: number;
  readonly turnStartedAt: string;
  // §5 — the turn's closures.
  readonly reArmIfStrandedNoAnswer: () => void;
  readonly stashContinuationIfHuman: () => void;
  readonly persistRoutingMarker: (label: string) => void;
  readonly persistAndBroadcastSystemRow: (content: string) => string;
  readonly noteTerminalAnswer: (rowId: string, surface: string) => void;
  readonly identicalCallState: RepeatCallState;
  readonly reminderLaneRefusedSigs: Set<string>;
  readonly deliverEngineUserAck: (
    text: string, originIntent?: string | null, reuseId?: string | null, displayKind?: DisplayKind | null,
  ) => Promise<void>;
  // §6 — the F10 start-ack.
  readonly counterpartyIsAgentSender: boolean;
  readonly startAckArmed: boolean;
  readonly startAckArmedAtMs: number;
  readonly startAckRepliedNow: () => boolean;
  readonly fireStartAckIfOwed: (via: 'timer' | 'first-tool') => Promise<void>;
  // §9 — the three step contexts.
  readonly finalizeContext: StepContextsOutputs['finalizeContext'];
  readonly teardownContext: StepContextsOutputs['teardownContext'];
  readonly preCallGatesContext: StepContextsOutputs['preCallGatesContext'];
}

/** The step's outcome. TWO directives and no more — see `PreflightOutcome`. */
export type PreflightStepOutcome = PreflightOutcome<PreflightOutputs>;

/**
 * Run everything the turn decides before its main `try` opens.
 *
 * ⚠ THE SIGNATURE IS THE CONTRACT'S ONE DELIBERATE EXCEPTION: `(turnCtx, ctx)`, not
 * `(state, ctx)`. This step MAKES the state, publishes it to `turnCtx.state`, and
 * hands back everything the rest of the turn reads.
 */
export async function runPreflight(
  turnCtx: TurnContext,
  ctx: PreflightContext,
): Promise<PreflightStepOutcome> {
  const sc: PreflightScratch = {
    claimedEngineEvent: null,
    pendingEngineClaim: null,
    terminalAnswerRowId: null,
  };

  const trigger = runTurnTrigger(turnCtx, ctx);
  if (trigger.directive === 'abandon') return trigger;
  const {
    db, agent, configuredModelId, isAutoRouted, contextModelId, contextWindow,
    waitingConvs, openHumanWorkAtTurnStart, continuation, isHumanContinuation,
    chosenConvKey, chosenConversationId, triggerRow, lastUserMessageContent,
    lastUserMessageId, triggerWorkId, triggerConversationId,
  } = trigger.outputs;

  const {
    revertTriggerStampOnAbort, latestUserSource, latestTtsEngine, triggeredByIMessage,
    inboundChannel, inboundContext, unrepliedAssign,
  } = runInboundAndAbort(turnCtx, ctx, sc, { db, triggerRow, triggerWorkId, lastUserMessageContent });

  const classified = await runTurnClassification(turnCtx, ctx, sc, {
    db, waitingConvs, openHumanWorkAtTurnStart, triggerRow, chosenConvKey,
    lastUserMessageContent, unrepliedAssign,
  });
  if (classified.directive === 'abandon') return classified;
  const {
    mostRecentInbound, mostRecentIsA2A, terminalWakeA2A, hasUnansweredUser, isA2ATurn,
    terminalWakeDrivesTurn, pendingEngineEvent, isEngineTurn, settledContextWakeTurn,
    isNotificationTurn, a2aReplyContext, a2aReplyAssignMessageId, a2aCounterpartyIdentity,
  } = classified.outputs;

  // The state is born here, and from this statement on it lives on the turn's bag.
  const { counterparty, turnNumber, turnStartedAt } = await runCounterpartyAndRecord(turnCtx, ctx, sc, {
    isHumanContinuation, continuation, a2aCounterpartyIdentity, lastUserMessageContent,
    lastUserMessageId, triggerRow, triggerWorkId, chosenConvKey, inboundChannel,
    inboundContext, latestUserSource, triggeredByIMessage, isA2ATurn, isEngineTurn,
    terminalWakeA2A, terminalWakeDrivesTurn, pendingEngineEvent, a2aReplyContext,
    contextWindow, isAutoRouted, configuredModelId,
  });

  const {
    reArmIfStrandedNoAnswer, stashContinuationIfHuman, persistRoutingMarker,
    persistAndBroadcastSystemRow, noteTerminalAnswer, identicalCallState,
    reminderLaneRefusedSigs, deliverEngineUserAck,
  } = runTurnClosures(turnCtx, ctx, sc, {
    counterparty, chosenConvKey, chosenConversationId, turnNumber, revertTriggerStampOnAbort,
  });

  const {
    counterpartyIsAgentSender, startAckArmed, startAckArmedAtMs, startAckRepliedNow,
    fireStartAckIfOwed,
  } = runStartAck(turnCtx, ctx, { db, counterparty, triggerRow, turnNumber });

  await runCloseoutGate(turnCtx, ctx, { db, triggerRow });

  // T47's sibling gate, immediately after the one it inherits BUG-2 from — same lane
  // separation, same `triggerRow` ternary, and their allowed sets union so a turn armed by
  // both always has a legal move (`compile-owed-gate.ts` argues the collision).
  runCompileGate(turnCtx, ctx, { triggerRow });

  runRecallFlag(turnCtx, ctx, { db });

  const { finalizeContext, teardownContext, preCallGatesContext } = runStepContexts(turnCtx, ctx, sc, {
    db, turnNumber, counterparty, counterpartyIsAgentSender, chosenConvKey,
    chosenConversationId, turnStartedAt, settledContextWakeTurn, isA2ATurn, isEngineTurn,
    triggerWorkId, inboundChannel, inboundContext, contextWindow, contextModelId,
    configuredModelId, isAutoRouted, noteTerminalAnswer, persistRoutingMarker,
    reArmIfStrandedNoAnswer, stashContinuationIfHuman,
  });

  return preflightProceed({
    db, agent, configuredModelId, isAutoRouted, contextModelId, contextWindow,
    waitingConvs, isHumanContinuation, chosenConvKey, triggerRow, lastUserMessageContent,
    triggerWorkId, triggerConversationId,
    revertTriggerStampOnAbort, latestUserSource, latestTtsEngine, inboundChannel,
    unrepliedAssign,
    mostRecentInbound, mostRecentIsA2A, hasUnansweredUser, isA2ATurn, pendingEngineEvent,
    isEngineTurn, settledContextWakeTurn, isNotificationTurn, a2aReplyContext,
    a2aReplyAssignMessageId,
    counterparty, turnNumber, turnStartedAt,
    reArmIfStrandedNoAnswer, stashContinuationIfHuman, persistRoutingMarker,
    persistAndBroadcastSystemRow, noteTerminalAnswer, identicalCallState,
    reminderLaneRefusedSigs, deliverEngineUserAck,
    counterpartyIsAgentSender, startAckArmed, startAckArmedAtMs, startAckRepliedNow,
    fireStartAckIfOwed,
    finalizeContext, teardownContext, preCallGatesContext,
  });
}
