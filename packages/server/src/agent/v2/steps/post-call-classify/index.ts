// The postCallClassify step: everything the engine decides after the model has spoken and before any
// tool runs. A floor's output is a steer (a model-visible system row), never a line spoken as the agent.
// User turns are never reclassified mid-turn; `turn-classification.ts` holds that for the post-model half.

import type { Database } from 'better-sqlite3';
import type { DisplayKind } from '@dojo/shared';
import type { ModelCallResult } from '../../../model.js';
import type { TurnContext } from '../../../turn-context.js';
import type { TurnCounterparty } from '../../counterparty.js';
import type { AgentRequest } from '../../owed.js';
import { type AgentTurnState } from '../../state.js';
import { proceed } from '../step-outcome.js';
import { runEmptyResponse } from './empty-response.js';
import { runTurnClassification } from './turn-classification.js';
import { runTerminalText } from './terminal-text.js';
import { runReplyFloors } from './reply-floors.js';
import { runNoReply } from './no-reply.js';
import { runCloseoutFloors } from './closeout-floors.js';
import { runPersistAssistant } from './persist-assistant.js';
import { runNoToolCalls } from './no-tool-calls.js';
import { runOwedInterrupt } from './owed-interrupt.js';

/** The phase the driver advances INTO before calling this step. It never writes it. */
export const POST_CALL_CLASSIFY_PHASE = 'postCallClassify' as const;

/** The model call's result, imported from the module that owns the shape so the two cannot drift. */
export type PostCallModelResult = ModelCallResult;

/** What this step reads from the driver, plus the two values `callLLM` produced this iteration. */
export interface PostCallClassifyContext {
  readonly agentId: string;
  readonly turnCtx: TurnContext;
  readonly turnNumber: number;
  readonly db: Database;
  readonly agent: { name?: string | null; [key: string]: unknown };
  readonly counterparty: TurnCounterparty;
  readonly counterpartyIsAgentSender: boolean;
  readonly chosenConvKey: string | null;
  readonly hasUnansweredUser: boolean;
  readonly triggerRow: { rowid: number; content: string; [key: string]: unknown } | null;
  readonly isA2ATurn: boolean;
  readonly isEngineTurn: boolean;
  readonly isHumanContinuation: boolean;
  readonly mostRecentIsA2A: boolean;
  readonly mostRecentInbound: { origin_intent?: string | null; [key: string]: unknown } | undefined;
  readonly pendingEngineEvent: { originIntent?: string | null; [key: string]: unknown } | null;
  readonly unrepliedAssign: AgentRequest | null;
  readonly a2aReplyContext: { intent?: string; threadShort?: string; fromName?: string } | null;
  readonly a2aReplyAssignMessageId: string | null;
  readonly settledContextWakeTurn: boolean;
  readonly waitingConvs: ReadonlyArray<{ key: string; oldestWaitingRowid: number; latest: { content: unknown } }>;
  readonly inboundChannel: string | null;
  readonly latestUserSource: string | null;
  readonly lastUserMessageContent: string | null;
  readonly configuredModelId: string;
  readonly turnStartedAt: string;

  /** Produced by `callLLM` in THIS iteration. */
  readonly messageId: string;
  readonly result: PostCallModelResult;

  /** Read outside this step too, so the driver hands it across rather than it being moved or copied. */

  /** Driver-owned closures, passed rather than imported so a step never imports the driver. */
  readonly reArmIfStrandedNoAnswer: () => void;
  readonly noteTerminalAnswer: (rowId: string, surface: string) => void;
  readonly deliverEngineUserAck: (
    text: string, originIntent: string | null, reuseId?: string | null, displayKind?: DisplayKind | null,
  ) => Promise<void>;
  readonly persistAndBroadcastSystemRow: (content: string) => void;
  readonly startAckRepliedNow: () => boolean;
}

/** Values passed between this step's sections; mutable because sections both read and write them. */
export interface PostCallScratch {
  persistedContent: string | null;
  interAgentTurn: boolean;
  deliberateSurfaceTurn: boolean;
  deliveredAsStartLine: boolean;
  hasXmlFallbackTools: boolean;
  effectiveModelIdForPersist: string;
}

/** On `proceed`, carries the four values the iteration's `execute` context reads; other arms end it. */
export type PostCallClassifyOutcome =
  | {
      readonly directive: 'proceed';
      readonly state: AgentTurnState;
      readonly persistedContent: string | null;
      readonly interAgentTurn: boolean;
      readonly hasXmlFallbackTools: boolean;
      readonly effectiveModelIdForPersist: string;
    }
  | { readonly directive: 'continue'; readonly state: AgentTurnState }
  // No `abandon` arm: leaving the turn rather than the loop belongs to `callLLM` alone (stop pressed,
  // or a peer preempted, during the model call).
  | { readonly directive: 'exit'; readonly state: AgentTurnState; readonly reason: string };

/** Runs the sections in a load-bearing order: suppression before the floors that read surviving text, and
 *  the assistant row persisted before the turn-ending family asks whether the person heard anything. */
export async function runPostCallClassify(
  state: AgentTurnState,
  ctx: PostCallClassifyContext,
): Promise<PostCallClassifyOutcome> {
  const { result, configuredModelId } = ctx;

  const sc: PostCallScratch = {
    persistedContent: null,
    interAgentTurn: false,
    deliberateSurfaceTurn: false,
    deliveredAsStartLine: false,
    hasXmlFallbackTools: false,
    effectiveModelIdForPersist: configuredModelId,
  };

  const empty = runEmptyResponse(state, ctx);
  if (empty.directive !== 'proceed') return empty as PostCallClassifyOutcome;
  state = empty.state;

  const classified = runTurnClassification(state, ctx, sc);
  if (classified.directive !== 'proceed') return classified as PostCallClassifyOutcome;
  state = classified.state;

  const text = await runTerminalText(state, ctx, sc);
  if (text.directive !== 'proceed') return text as PostCallClassifyOutcome;
  state = text.state;

  const floors = await runReplyFloors(state, ctx, sc);
  if (floors.directive !== 'proceed') return floors as PostCallClassifyOutcome;
  state = floors.state;

  const noReply = await runNoReply(state, ctx, sc);
  if (noReply.directive !== 'proceed') return noReply as PostCallClassifyOutcome;
  state = noReply.state;

  const closeout = runCloseoutFloors(state, ctx, sc);
  if (closeout.directive !== 'proceed') return closeout as PostCallClassifyOutcome;
  state = closeout.state;

  const persisted = await runPersistAssistant(state, ctx, sc);
  if (persisted.directive !== 'proceed') return persisted as PostCallClassifyOutcome;
  state = persisted.state;

  if (result.toolCalls.length === 0) {
    const ended = await runNoToolCalls(state, ctx, sc);
    if (ended.directive !== 'proceed') return ended as PostCallClassifyOutcome;
    state = ended.state;
  } else {
    // A mid-turn arrival must reach the model before the turn's answer, so the owed-interrupt check also
    // runs on passes that called tools. Here it returns `proceed`: this pass's tool calls have not run
    // yet and a `continue` would drop them; its steer rides the queue into the next assembly.
    const owedInFlight = await runOwedInterrupt(state, ctx, sc);
    if (owedInFlight.directive !== 'proceed') return owedInFlight as PostCallClassifyOutcome;
    state = owedInFlight.state;
  }

  return {
    ...proceed(state),
    persistedContent: sc.persistedContent,
    interAgentTurn: sc.interAgentTurn,
    hasXmlFallbackTools: sc.hasXmlFallbackTools,
    effectiveModelIdForPersist: sc.effectiveModelIdForPersist,
  } as PostCallClassifyOutcome;
}
