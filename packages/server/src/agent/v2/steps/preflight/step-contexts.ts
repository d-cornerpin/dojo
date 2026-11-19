// Builds the contexts `finalize`, `teardown` and `preCallGates` read. They are closures, not objects,
// because several values they read are still written up to the last statement of the turn.

import type { Database } from 'better-sqlite3';
import type { TurnContext } from '../../../turn-context.js';
import { broadcast } from '../../../../gateway/ws.js';
import type { InboundChannel } from '../../inbound-channel.js';
import type { ChannelInboundContext } from '../../state.js';
import type { TurnCounterparty } from '../../counterparty.js';
import type { FinalizeContext } from '../finalize/index.js';
import type { TeardownContext } from '../teardown/index.js';
import type { PreCallGatesContext } from '../pre-call-gates/index.js';
import type { PreflightContext, PreflightScratch } from './index.js';

/** Inputs from every earlier section, which is why this section runs last. */
export interface StepContextsInputs {
  readonly db: Database;
  readonly turnNumber: number;
  readonly counterparty: TurnCounterparty;
  readonly counterpartyIsAgentSender: boolean;
  readonly chosenConvKey: string;
  readonly chosenConversationId: string | null;
  readonly turnStartedAt: string;
  readonly settledContextWakeTurn: boolean;
  readonly isA2ATurn: boolean;
  readonly isEngineTurn: boolean;
  readonly triggerWorkId: string | null;
  readonly inboundChannel: InboundChannel;
  readonly inboundContext: ChannelInboundContext | null;
  readonly contextWindow: number;
  readonly contextModelId: string;
  readonly configuredModelId: string;
  readonly isAutoRouted: boolean;
  readonly noteTerminalAnswer: (rowId: string, surface: string) => void;
  readonly persistRoutingMarker: (label: string) => void;
  readonly reArmIfStrandedNoAnswer: () => void;
}

export interface StepContextsOutputs {
  readonly finalizeContext: () => FinalizeContext;
  readonly teardownContext: () => TeardownContext;
  readonly preCallGatesContext: () => PreCallGatesContext;
}

export function runStepContexts(
  turnCtx: TurnContext,
  ctx: PreflightContext,
  sc: PreflightScratch,
  input: StepContextsInputs,
): StepContextsOutputs {
  const { agentId, stopStatusHeartbeat } = ctx;
  const {
    db, turnNumber, counterparty, chosenConvKey,
    chosenConversationId, turnStartedAt, settledContextWakeTurn, isA2ATurn, isEngineTurn,
    triggerWorkId, inboundChannel, inboundContext, contextWindow, contextModelId,
    configuredModelId, isAutoRouted, noteTerminalAnswer, persistRoutingMarker,
    reArmIfStrandedNoAnswer,
  } = input;
  const finalizeContext = (): FinalizeContext => ({
    agentId, turnCtx, turnNumber, db,
    counterparty, chosenConvKey, turnStartedAt,
    settledContextWakeTurn, isA2ATurn, isEngineTurn, broadcast,
    noteTerminalAnswer, persistRoutingMarker, stopStatusHeartbeat,
  });

  const teardownContext = (): TeardownContext => ({
    agentId, turnCtx, turnNumber, db,
    chosenConvKey, chosenConversationId, lastAssembledAtIso: turnCtx.lastAssembledAtIso,
    terminalAnswerRowId: sc.terminalAnswerRowId, triggerWorkId, claimedEngineEvent: sc.claimedEngineEvent,
    toolPhaseEndedBySpinBrake: turnCtx.toolPhaseEndedBySpinBrake,
    counterparty, isA2ATurn, isEngineTurn, turnStartedAt,
    inboundChannel, inboundContext,
    reArmIfStrandedNoAnswer, stopStatusHeartbeat,
  });

  // Runs once per iteration, so the per-iteration fields must be read at call time, never snapshotted.
  const preCallGatesContext = (): PreCallGatesContext => ({
    agentId, turnNumber, contextWindow, contextModelId, configuredModelId, isAutoRouted,
    counterparty,
    broadcast,
  });

  return { finalizeContext, teardownContext, preCallGatesContext };
}
