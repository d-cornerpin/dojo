// THE `assemble` STEP: a step is a directory with one entry point; this is it. It builds the one
// shared turn context, picks the model before the build, records the volatile boundary, appends the
// loop's tail entries, and drains one steer onto the tail. The driver owns the advance into this phase.

import { liveAddress } from '../../turn-address-live.js';
import { assembleContext, type AssembledContext } from '../../../../memory/assembler.js';
import { assembleWithNothingOutOfViewUnsummarised } from '../../../../memory/out-of-view.js';
import { buildAssemblyContext } from '../../../../prompt/registry/assembler.js';
import type { AssemblyContext } from '../../../../prompt/registry/types.js';
import type { PromptTurnContext } from '../../../../prompt/assembler.js';
import { broadcast } from '../../../../gateway/ws.js';
import { clearConsumedOneShotFlags } from '../../../runtime.js';
import { inboundIsWork } from '../../classifiers/inbound-routing.js';
import { advance, type AgentTurnState } from '../../state.js';
import type { SteerEntry } from '../../steer-queue.js';
import type { TurnContext } from '../../../turn-context.js';
import type { TurnCounterparty } from '../../counterparty.js';
import { createLogger } from '../../../../logger.js';
import { injectTechniqueAndGapHints } from './technique-hints.js';
import { techniqueRoomTokens } from '../../../../memory/technique-room.js';
import { detectMultistepAndScaffold } from './multistep-detection.js';
import { injectDelegationHintAndAttachments } from './delegation-and-attachments.js';
import { runSteerCheckpoint } from './steer-checkpoint.js';
import { withHandBackFacts } from './hand-back-steer.js';
import { proceed, requestExit } from '../step-outcome.js';
import { selectModel, type ModelSelection } from '../call-llm/model-selection.js';
import { agentTurnWindow } from '../../../../router/router-window.js';

const logger = createLogger('v2-loop');

/** The phase the driver advances INTO before calling this step. It never writes it. */
export const ASSEMBLE_PHASE = 'assemble' as const;

type ModelMessage = AssembledContext['messages'][number];

/** Everything the span read from the driver, measured not guessed; `state` rides the step contract. */
export interface AssembleContext {
  readonly agentId: string;
  readonly turnCtx: TurnContext;
  readonly turnNumber: number;
  readonly db: import('better-sqlite3').Database;
  readonly contextModelId: string;
  readonly contextWindow: number;
  readonly counterparty: TurnCounterparty;
  readonly counterpartyIsAgentSender: boolean;
  readonly chosenConvKey: string | null;
  readonly hasUnansweredUser: boolean;
  readonly isA2ATurn: boolean;
  readonly isEngineTurn: boolean;
  readonly isNotificationTurn: boolean;
  readonly lastUserMessageContent: string | null;
  readonly latestTtsEngine: 'local' | 'cloud' | null;
  readonly latestUserSource: 'text' | 'voice' | null;
  readonly mostRecentIsA2A: boolean;
  readonly pendingEngineEvent: { rowid: number; originIntent?: string | null } | null;
  /** The newest inbound row, the SAME one `isNotificationTurn` tested; read only to resolve its id. */
  readonly mostRecentInbound: { rowid: number } | null | undefined;
  readonly waitingConvs: ReadonlyArray<unknown>;
  /** Safe BY VALUE: its one write site (post-call terminal text) cannot run while this step is awaited. */
  readonly engineStartAckDeliveredThisTurn: boolean;
  readonly staleTaskWindowMinutes: number;
  /** Driver CLOSURES and helpers, passed as values so bindings stay live and no step points back. */
  readonly startAckRepliedNow: () => boolean;
  /** Chosen here, before the build; `contextModelId` `'__auto__'` is only a stand-in, never built for. */
  readonly isAutoRouted: boolean;
  readonly revertTriggerStampOnAbort: () => void;
}

/** A module cannot leave a declaration behind: the span's seven values come back on the proceed arm. */
export type AssembleOutcome =
  | {
      readonly directive: 'proceed';
      readonly state: AgentTurnState;
      readonly assembled: AssembledContext;
      readonly messages: ModelMessage[];
      readonly systemPrompt: string;
      readonly volatileFrom: number;
      readonly modelContext: AssemblyContext;
      readonly steerAwaitingConfirm: SteerEntry | null;
      readonly selection: ModelSelection;
      /** The context `assembleContext` saw: callLLM's fit re-assembly reuses it, or headers and counts diverge. */
      readonly assemblyTurnContext: PromptTurnContext;
    }
  | { readonly directive: 'exit'; readonly state: AgentTurnState; readonly reason: string };

export async function runAssemble(stateIn: AgentTurnState, ctxIn: AssembleContext): Promise<AssembleOutcome> {
  const {
    agentId, turnCtx, turnNumber, db, contextModelId, contextWindow, counterparty,
    counterpartyIsAgentSender, chosenConvKey, hasUnansweredUser, isA2ATurn, isEngineTurn,
    isNotificationTurn, lastUserMessageContent, latestTtsEngine, latestUserSource,
    mostRecentIsA2A, pendingEngineEvent, mostRecentInbound, waitingConvs, engineStartAckDeliveredThisTurn,
    staleTaskWindowMinutes, startAckRepliedNow, isAutoRouted,
  } = ctxIn;
  let state = stateIn;

  // Intent companion: a quick conversational ask must not spin up a tracked task that then churns.
  const conversationalTurn = counterparty.kind === 'user'
    && await inboundIsWork(turnCtx, agentId, lastUserMessageContent ?? '') === false;
  // Keep THIS turn's trigger row whole, by row identity, never a category (engine: `pendingEngineEvent`,
  // notification: `mostRecentInbound`): on a sparse tail gisting it empties the tail. Older notices still gist.
  let engineEventKeepFullId: string | null = null;
  const turnTriggerRowid =
    isEngineTurn && pendingEngineEvent ? pendingEngineEvent.rowid
    : isNotificationTurn && mostRecentInbound ? mostRecentInbound.rowid
    : null;
  if (turnTriggerRowid != null) {
    try {
      const idRow = db.prepare('SELECT id FROM messages WHERE agent_id = ? AND rowid = ?')
        .get(agentId, turnTriggerRowid) as { id: string } | undefined;
      engineEventKeepFullId = idRow?.id ?? null;
    } catch { /* best effort, fall back to the truncated awareness gist */ }
  }
  // ONE shared turn context, threaded into BOTH `assembleContext` (system) AND the injection mctx.
  const sharedTurnContext = { latestUserSource, ttsEngine: latestTtsEngine, isA2ATurn, isEngineTurn, isNotificationTurn, counterparty, othersWaiting: Math.max(0, waitingConvs.length - 1), conversationalTurn, engineEventKeepFullId, address: liveAddress(turnCtx.address) };
  // Pre-model terms only, stamped now because suppression needs the kind early; the post-call re-stamp adds
  // the rest. In both places a human-counterparty turn stays 'user' its whole life, never flipped to 'a2a'.
  const preModelInterAgent = counterparty.kind !== 'user' && (isA2ATurn || counterparty.kind === 'agent' || (mostRecentIsA2A && !hasUnansweredUser));
  if (preModelInterAgent && turnCtx.kind !== 'a2a') {
    turnCtx.kind = 'a2a';
    broadcast({ type: 'agent:status', agentId, status: 'working', turnKind: 'a2a', userFacing: !!chosenConvKey });
  }
  // Chosen before the build, so an auto-routed turn is built once, for its pick.
  const routed = await selectModel(state, {
    agentId, isAutoRouted, configuredModelId: contextModelId, lastUserMessageContent, conversationId: turnCtx.conversationId ?? null,
    turnNumber, turnContext: sharedTurnContext, revertTriggerStampOnAbort: ctxIn.revertTriggerStampOnAbort,
  });
  state = routed.state;
  if (routed.said !== undefined) return requestExit(state, routed.said) as Extract<AssembleOutcome, { directive: 'exit' }>;
  const modelId = routed.selection.modelId;
  const dialWindow = modelId === contextModelId ? contextWindow : agentTurnWindow(agentId, modelId);   // one window for every pick
  // The assembly this turn dials never leaves a row out of view without a bounded, awaited summary.
  const ctx = await assembleWithNothingOutOfViewUnsummarised(agentId, dialWindow,
    () => assembleContext(agentId, modelId, sharedTurnContext));
  // ASSEMBLY IS A READ; THE TURN OWNS THE WRITE: the assembler REPORTS what it consumed, this clears once.
  clearConsumedOneShotFlags(agentId, ctx.consumedOneShotFlags);
  // The compile-order WHOLE verdict for the gate, re-derived from THIS iteration's array, never latched.
  state = advance(state, { compileOrderReachedModel: ctx.compileOrderIntact === true });
  // THE VOLATILE BOUNDARY for the prefix gate: everything the ALLOCATOR produced is the cacheable region;
  // everything appended below is the volatile tail, re-emitted every iteration, never prefix churn.
  const volatileFrom = ctx.messages.length;
  turnCtx.lastAssembledAtIso = new Date().toISOString(); // see assembledContextAsks
  let systemPrompt = ctx.systemPrompt;
  const messages = ctx.messages;
  // Older fresh-tail groups dropped to fit: nothing lost, the owner hears nothing; logged once per turn.
  if (!turnCtx.freshTailDropWarned && (ctx.freshTailDropped ?? 0) > 0) {
    turnCtx.freshTailDropWarned = true;
    logger.warn('assembler evicted oldest fresh-tail messages to fit the window (live-view loss)', {
      agentId, dropped: ctx.freshTailDropped ?? 0, contextWindow: dialWindow,
    }, agentId);
  }

  // One message-injection context for this iteration's registry entries; the loop sets fields per site.
  const mctx: AssemblyContext = buildAssemblyContext(
    agentId,
    modelId,
    sharedTurnContext,
    { loopCount: state.loopCount, turnNumber, lastUserMessageContent: lastUserMessageContent ?? '', pendingSteer: null },
  );

  await injectTechniqueAndGapHints(state, { agentId, lastUserMessageContent, mctx, messages, roomTokens: techniqueRoomTokens(ctx) });

  state = await detectMultistepAndScaffold(state, {
    agentId, turnNumber, turnCtx, db, counterparty, counterpartyIsAgentSender, lastUserMessageContent,
    engineStartAckDeliveredThisTurn, staleTaskWindowMinutes,
  });

  await injectDelegationHintAndAttachments(state, {
    agentId, turnNumber, counterparty, lastUserMessageContent, mctx, messages, roomTokens: ctx.allocation?.budgetTokens,
  });

  const steer = runSteerCheckpoint(withHandBackFacts(state, turnCtx, agentId, turnNumber), {
    agentId, turnCtx, turnNumber, engineStartAckDeliveredThisTurn, startAckRepliedNow, mctx, messages,
  });
  state = steer.state;
  const steerAwaitingConfirm = steer.steerAwaitingConfirm;

  // A zero-message assembly cannot be dialed: exit clean, and the reason says so.
  if (messages.length === 0) {
    logger.info('v2: assembled context has zero messages, clean exit', {
      agentId,
      loopCount: state.loopCount,
    }, agentId);
    // The idle write lives with `teardown` (`settleStatus`), its one owner; nothing writes here.
    return requestExit(state, 'empty-assembled-context') as Extract<AssembleOutcome, { directive: 'exit' }>;
  }

  return {
    ...proceed(state), directive: 'proceed', state,
    assembled: ctx, messages, systemPrompt, volatileFrom, modelContext: mctx, steerAwaitingConfirm,
    selection: routed.selection, assemblyTurnContext: sharedTurnContext,
  } as AssembleOutcome;
}
