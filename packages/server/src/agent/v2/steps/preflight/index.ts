// The `preflight` step: everything a turn decides before its main `try` opens. It is the one step that
// takes no `state` because it makes it, publishing it to the bag (`turnCtx.state`) since closures read it
// live. Its only exit is `abandon` (another process claimed the trigger): neither finalize nor teardown runs.

import type { Database } from 'better-sqlite3';
import type { AgentStatus, DisplayKind } from '@dojo/shared';
import type { TurnContext } from '../../../turn-context.js';
import type { InboundChannel } from '../../inbound-channel.js';
import type { TurnCounterparty, WaitingConversation } from '../../counterparty.js';
import type { UnrepliedAssign } from '../../../a2a-replies.js';
import { preflightProceed, type PreflightOutcome } from '../step-outcome.js';
import { runTurnTrigger } from './turn-trigger.js';
import { turnAnswersSpokenRequest } from '../../../../memory/served-ask.js';
import { runInboundAndAbort } from './inbound-and-abort.js';
import { runTurnClassification } from './turn-classification.js';
import { runCounterpartyAndRecord } from './counterparty-and-record.js';
import { runTurnClosures } from './turn-closures.js';
import { runStartAck } from './start-ack.js';
import { runCompileGate } from './compile-gate.js';
import { runRecallFlag } from './recall-flag.js';
import { runStepContexts } from './step-contexts.js';
import type { StepContextsOutputs } from './step-contexts.js';

/** The phase this step runs in; the driver never advances into it because `initState` seeds it. */
export const PREFLIGHT_PHASE = 'preflight' as const;

/** Inputs from outside the span; functions are passed, not imported, so a step never imports the driver. */
export interface PreflightContext {
  readonly agentId: string;
  readonly setAgentStatus: (agentId: string, status: AgentStatus) => void;
  readonly startStatusHeartbeat: (agentId: string) => void;
  readonly stopStatusHeartbeat: (agentId: string) => void;
  readonly engineStartAckAfterMs: number;
}

/** Mutable scratch shared by this step's sections, living for one `runPreflight` call. */
export interface PreflightScratch {
  /** Set at the engine-event pickup when this turn wins the CAS; finalize hands back exactly it. */
  claimedEngineEvent: { rowid: number; turnNumber: number } | null;
  /** The event this turn intends to claim; it becomes `claimedEngineEvent` only if the CAS wins. */
  pendingEngineClaim: { rowid: number } | null;
  /** Set only at persists that deliver a user-facing reply, never at acks, working notes or chip echoes.
   *  The turn record's answer is keyed on it, and `teardownContext` reads it live. */
  terminalAnswerRowId: string | null;
}

/** What the rest of the turn reads from this span. */
export interface PreflightOutputs {
  // The turn's trigger.
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
  // The inbound channel and the abort revert.
  readonly revertTriggerStampOnAbort: () => void;
  readonly latestUserSource: 'voice' | 'text' | null;
  readonly latestTtsEngine: 'local' | 'cloud' | null;
  readonly inboundChannel: InboundChannel;
  readonly unrepliedAssign: UnrepliedAssign | null;
  // What kind of turn this is.
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
  // The counterparty and the turn record.
  readonly counterparty: TurnCounterparty;
  readonly turnNumber: number;
  readonly turnStartedAt: string;
  // The turn's closures.
  readonly reArmIfStrandedNoAnswer: () => void;
  readonly stashContinuationIfHuman: () => void;
  readonly persistRoutingMarker: (label: string) => void;
  readonly persistAndBroadcastSystemRow: (content: string) => string;
  readonly noteTerminalAnswer: (rowId: string, surface: string) => void;
  readonly refusedOnceSigs: Set<string>;
  readonly deliverEngineUserAck: (
    text: string, originIntent?: string | null, reuseId?: string | null, displayKind?: DisplayKind | null,
  ) => Promise<void>;
  // The start-ack.
  readonly counterpartyIsAgentSender: boolean;
  readonly startAckArmed: boolean;
  readonly startAckArmedAtMs: number;
  readonly startAckRepliedNow: () => boolean;
  readonly fireStartAckIfOwed: (via: 'timer' | 'first-tool') => Promise<void>;
  // The three step contexts.
  readonly finalizeContext: StepContextsOutputs['finalizeContext'];
  readonly teardownContext: StepContextsOutputs['teardownContext'];
  readonly preCallGatesContext: StepContextsOutputs['preCallGatesContext'];
}

/** The step's outcome: proceed with outputs, or abandon. */
export type PreflightStepOutcome = PreflightOutcome<PreflightOutputs>;

/** Runs everything the turn decides before its main `try` opens, making the state rather than taking it. */
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
    waitingConvs, openHumanWorkAtTurnStart, item, continuation, isHumanContinuation,
    chosenConvKey, chosenConversationId, triggerRow, lastUserMessageContent,
    lastUserMessageId, triggerWorkId, triggerConversationId,
  } = trigger.outputs;

  const {
    revertTriggerStampOnAbort, triggeredByIMessage,
    inboundChannel, inboundContext, unrepliedAssign,
  } = runInboundAndAbort(turnCtx, ctx, { triggerRow, lastUserMessageContent });

  const classified = await runTurnClassification(turnCtx, ctx, sc, {
    db, waitingConvs, openHumanWorkAtTurnStart, item, triggerRow, chosenConvKey,
    lastUserMessageContent, unrepliedAssign,
  });
  if (classified.directive === 'abandon') return classified;
  // Roots are final here: whether the request this turn answers was spoken picks the voice-conduct block, the
  // filler, the no-reply line and read-aloud alike, and the engine picks the flat or the expressive addendum.
  const latestUserSource = turnAnswersSpokenRequest(ctx.agentId) ? 'voice' : triggerRow ? 'text' : null;
  const latestTtsEngine = latestUserSource === 'voice'
    ? (await import('../../../../voice/voice-settings.js')).loadVoiceSettings().ttsEngine : null;
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
    contextWindow, isAutoRouted, configuredModelId, isNotificationTurn, settledContextWakeTurn, notificationTriggerRowid: isNotificationTurn ? (mostRecentInbound?.rowid ?? null) : null,
  });

  const {
    reArmIfStrandedNoAnswer, stashContinuationIfHuman, persistRoutingMarker,
    persistAndBroadcastSystemRow, noteTerminalAnswer,
    refusedOnceSigs, deliverEngineUserAck,
  } = runTurnClosures(turnCtx, ctx, sc, {
    counterparty, chosenConvKey, chosenConversationId, turnNumber, revertTriggerStampOnAbort,
  });

  const {
    counterpartyIsAgentSender, startAckArmed, startAckArmedAtMs, startAckRepliedNow,
    fireStartAckIfOwed,
  } = runStartAck(turnCtx, ctx, { db, counterparty, triggerRow, turnNumber });

  // Never arms on a turn serving a waiting human (`triggerRow` set); see `compile-gate.ts`.
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
    persistAndBroadcastSystemRow, noteTerminalAnswer,
    refusedOnceSigs, deliverEngineUserAck,
    counterpartyIsAgentSender, startAckArmed, startAckArmedAtMs, startAckRepliedNow,
    fireStartAckIfOwed,
    finalizeContext, teardownContext, preCallGatesContext,
  });
}
