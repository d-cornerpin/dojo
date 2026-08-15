// ════════════════════════════════════════
// PHASE-6 T2 (CUT 9) — `preflight` §9: THE THREE STEP CONTEXTS.
//
// What `finalize`, `teardown` and `preCallGates` read from this span, gathered at the
// moment each is CALLED. They are CLOSURES and not objects, and every one of the three
// says so at its own site: several of the values they read are still being written
// right up to the last statement of the turn, so a snapshot taken before the main
// `try` would hand each step a picture of the turn as it began.
//
// ⚠ THEY MOVE WITH THE SPAN, AND LEAVING THEM IN THE DRIVER WAS MEASURED AND REFUSED.
// `teardownContext` reads `terminalAnswerRowId` LIVE, so leaving it behind would
// manufacture a SECOND carrier for a local this package already owns — and it would
// change a landed tranche's context type, which is a redesign where this tranche's
// job is a relocation. The cost of moving them is three passthroughs and three
// sibling type imports; the cost of not moving them was a new mechanism.
//
// `ENGINE_BLOCK_ESCAPE_HATCH` arrives as an INPUT for the same reason `§6`'s threshold
// does: it is declared at `loop.ts`'s module level and read outside this span too.
// ════════════════════════════════════════

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

/** What the sections before this one produced that it reads — twenty-two values, the
 *  largest input surface in the package and the reason this section is last. */
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
  readonly stashContinuationIfHuman: () => void;
}

/** The three closures themselves. */
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
  const { agentId, setAgentStatus, stopStatusHeartbeat, detectTaskThrashing } = ctx;
  const ENGINE_BLOCK_ESCAPE_HATCH = ctx.engineBlockEscapeHatch;
  const {
    db, turnNumber, counterparty, counterpartyIsAgentSender, chosenConvKey,
    chosenConversationId, turnStartedAt, settledContextWakeTurn, isA2ATurn, isEngineTurn,
    triggerWorkId, inboundChannel, inboundContext, contextWindow, contextModelId,
    configuredModelId, isAutoRouted, noteTerminalAnswer, persistRoutingMarker,
    reArmIfStrandedNoAnswer, stashContinuationIfHuman,
  } = input;
  // G-SUP-2 (comms-audit): turn-scoped stash for user-facing text that rode with
  // tool calls and was deferred (suppressed as possible narration). Recovered at
  // turn-end ONLY if the turn delivered no proper tool-less reply, so a genuine
  // answer the weak model paired with a closing tool is never silently lost.

  // P4b: the F3 runway tripwire (a log-only guard on the guard) was DELETED
  // with the near-dup swallow; the turns record now audits the round.

  // PHASE-6 T9b: what the teardown step reads from this driver, gathered at the
  // moment it is called. It is a CLOSURE and not an object built here on purpose —
  // seven of these are mutable and are still being written right up to the last
  // statement of the turn, so a value snapshotted before the `try` would hand the
  // teardown a picture of the turn as it began. Reading them at call time is what
  // the lexical block did, and this is the smallest construct that keeps it.
  // PHASE-6 T9 (CUT 4): what the finalize step reads from this driver. A CLOSURE for
  // the same reason `teardownContext` is one — several of these are still being
  // written right up to the last statement of the loop, and a snapshot taken before
  // the `try` would hand finalize a picture of the turn as it began.
  const finalizeContext = (): FinalizeContext => ({
    agentId, turnCtx, turnNumber, db,
    counterparty, counterpartyIsAgentSender, chosenConvKey, turnStartedAt,
    settledContextWakeTurn, isA2ATurn, isEngineTurn, broadcast,
    noteTerminalAnswer, persistRoutingMarker, stopStatusHeartbeat, setAgentStatus,
  });

  const teardownContext = (): TeardownContext => ({
    agentId, turnCtx, turnNumber, db,
    chosenConvKey, chosenConversationId, lastAssembledAtIso: turnCtx.lastAssembledAtIso,
    terminalAnswerRowId: sc.terminalAnswerRowId, triggerWorkId,
    toolPhaseEndedBySpinBrake: turnCtx.toolPhaseEndedBySpinBrake,
    turnInjectedTechniqueId: turnCtx.turnInjectedTechniqueId,
    counterparty, isA2ATurn, isEngineTurn, turnStartedAt,
    inboundChannel, inboundContext,
    reArmIfStrandedNoAnswer, stopStatusHeartbeat,
  });

  // PHASE-6 T3: what the preCallGates step reads from this driver. A CLOSURE for the
  // same reason as the one above, and here it is load-bearing on three specific
  // fields: `assemblerOverheadTokens` is rewritten by every assemble,
  // `engineStartAckDeliveredThisTurn` and `deferredDeliveredByAck` by the post-call
  // classifier, and this step runs once per ITERATION — so a snapshot taken before
  // the `try` would hand iteration nine the picture iteration one had.
  // PHASE-6 T6 (CUT 8): the latter two now live on the turn's bag, so the closure reads
  // THEM off the bag. The per-iteration property this note is about is unchanged — the
  // read still happens at the call site — and the bag is what makes it true now that the
  // step that WRITES them is a module of its own.
  // `setAgentStatus` and `detectTaskThrashing` are passed rather than imported so a
  // step never points back at the driver (CUT 2's `stopStatusHeartbeat` precedent).
  const preCallGatesContext = (): PreCallGatesContext => ({
    agentId, turnNumber, contextWindow, contextModelId, configuredModelId, isAutoRouted,
    counterparty, assemblerOverheadTokens: turnCtx.assemblerOverheadTokens,
    // HL4 step 2 (2d): the ack-delivery pair is GONE from this closure — see the
    // removal note on `PreCallGatesContext`, whose reader was the retired recap.
    engineBlockEscapeHatch: ENGINE_BLOCK_ESCAPE_HATCH,
    broadcast, setAgentStatus, stashContinuationIfHuman, detectTaskThrashing,
  });

  return { finalizeContext, teardownContext, preCallGatesContext };
}
