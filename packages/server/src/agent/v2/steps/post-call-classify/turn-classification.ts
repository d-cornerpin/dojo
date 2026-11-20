// Classifies the turn after the model spoke; with a human counterparty it is never inter-agent.

import { broadcast } from '../../../../gateway/ws.js';
import { createLogger } from '../../../../logger.js';
import { type AgentTurnState } from '../../state.js';
import { sanitizeAssistantText } from '../../classifiers/output.js';
import { proceed, type StepOutcome } from '../step-outcome.js';
import type { PostCallClassifyContext, PostCallScratch } from './index.js';

const logger = createLogger('v2-loop');

/** Classify the turn; writes `interAgentTurn` and `deliberateSurfaceTurn` onto the scratch. */
export function runTurnClassification(
  state: AgentTurnState,
  ctx: PostCallClassifyContext,
  sc: PostCallScratch,
): StepOutcome {
  const {
    agentId, chosenConvKey, counterparty, hasUnansweredUser, isA2ATurn,
    isEngineTurn, isHumanContinuation, mostRecentInbound, mostRecentIsA2A,
    pendingEngineEvent, result, triggerRow, turnCtx, turnNumber, waitingConvs,
  } = ctx;
  result.content = sanitizeAssistantText(result.content ?? null) ?? '';

  // Read the pending engine event too: in a race mostRecentInbound is the human who out-raced it.
  const deliberateSurfaceTurn =
    mostRecentInbound?.origin_intent === 'scheduler' || mostRecentInbound?.origin_intent === 'completion_report' ||
    (isEngineTurn && (pendingEngineEvent?.originIntent === 'scheduler' || pendingEngineEvent?.originIntent === 'completion_report'));

  // A user-less turn that messages an agent is coordination, never text for the owner.
  const spontaneousA2ATurn =
    !hasUnansweredUser &&
    (state.sentToAgentThisTurn ||
      result.toolCalls.some(tc => tc.name === 'send_to_agent' || tc.name === 'broadcast_to_group'));
  const a2aBackgroundTurn = mostRecentIsA2A && !hasUnansweredUser;
  // Mid A2A exchange counts only with no human waiting; a waiting human makes this the user's turn.
  const a2aExchangeTurn = mostRecentIsA2A && state.sentToAgentThisTurn && !hasUnansweredUser;
  // Internal chatter, except deliberate surfaces and continuations of a human's task.
  const pureBackgroundTurn = !hasUnansweredUser && !triggerRow && !mostRecentIsA2A && !deliberateSurfaceTurn && !isHumanContinuation;
  // User turns are never reclassified: a human counterparty forces this false.
  const interAgentTurn = counterparty.kind !== 'user' && (isA2ATurn || counterparty.kind === 'agent' || spontaneousA2ATurn || a2aBackgroundTurn || a2aExchangeTurn || pureBackgroundTurn);
  // Re-stamp from the same predicate persistence uses, so the live view matches a reload.
  if (interAgentTurn && turnCtx.kind !== 'a2a') {
    turnCtx.kind = 'a2a';
    broadcast({ type: 'agent:status', agentId, status: 'working', turnKind: 'a2a', userFacing: !!chosenConvKey });
  }
  // Diagnostic: logs which waiting conversation flips an A2A poke into a user turn.
  if (mostRecentIsA2A && hasUnansweredUser) {
    logger.warn('v2 PHANTOM-FLIP: A2A turn flipped to user by waiting conversation', {
      agentId, turnNumber,
      waiting: waitingConvs.map(w => ({ key: w.key, oldest: w.oldestWaitingRowid, latest: String(w.latest.content).slice(0, 45) })),
    }, agentId);
  }
  sc.deliberateSurfaceTurn = deliberateSurfaceTurn;
  sc.interAgentTurn = interAgentTurn;
  return proceed(state);
}
