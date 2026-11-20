// The empty-response ladder: a grind rung for a response cut off at the output cap, then a silent retry, then
// for a person waiting the turn ends into the required reply, and otherwise a nudge and a give-up. Work done with
// nobody waiting is a clean exit, not a failure.

import { broadcast } from '../../../../gateway/ws.js';
import { createLogger } from '../../../../logger.js';
import { contractForConfiguredModel } from '../../../model.js';
import { advance, type AgentTurnState } from '../../state.js';
import { persistEngineSteer } from '../../engine-steer.js';
import { clearSteerQueueFor, steerFired, type SteerFloorId } from '../../steer-queue.js';
import { outputTruncationClassifier } from '../../classifiers/output.js';
import { continueLoop, proceed, requestExit, type StepOutcome } from '../step-outcome.js';
import type { PostCallClassifyContext } from './index.js';
import { userWords } from '../../turn-address.js';
import { replyCanBeRequired } from '../../forced-reply.js';

const logger = createLogger('v2-loop');

/** The only steer entries the ladder's give-up rungs may abandon: they speak about this model call
 *  producing nothing usable, and must not abandon other floors' undelivered steers. */
const EMPTY_LADDER_FAMILY: readonly SteerFloorId[] = ['output-grind', 'empty-response'];

/** The empty-response ladder. `proceed` means the response was not empty. */
export function runEmptyResponse(state: AgentTurnState, ctx: PostCallClassifyContext): StepOutcome {
  const { agentId, turnNumber, result, reArmIfStrandedNoAnswer } = ctx;

  // Grind rung: the provider reports the response hit the model's own output cap (a fact, not a
  // threshold). It runs before the empty ladder, which would misname a grind and retry it silently and
  // never sees a grind that wrote a fragment. Steered once, by the queue's per-floor latch.
  const grindTrunc = outputTruncationClassifier({
    stopReason: result.stopReason,
    contentLength: result.content?.length ?? 0,
    currentBudget: result.outputRoom?.sent ?? 0,
    ceiling: result.outputRoom?.ceiling,
    alreadyEscalated: state.outputTokensEscalated > 0,
  });
  // Any cut response takes this rung, tool call or not: it returns before the row persists or any call runs.
  if (grindTrunc.truncated) {
    if (!steerFired(state.steerQueue, 'output-grind')) {
      // The first grind also gets real extra room: `call-llm/model-call.ts` reads the ask and
      // `resolveOutputBudget` sizes it against the model and the window.
      if (grindTrunc.escalateTo !== null) {
        state = advance(state, { outputTokensEscalated: grindTrunc.escalateTo });
      }
      logger.warn('v2: the model spent its whole output budget (cut off) — steering, not re-running', {
        loopCount: state.loopCount, stopReason: result.stopReason,
        contentChars: result.content?.length ?? 0, cutToolCalls: result.toolCalls.length,
      }, agentId);
      state = persistEngineSteer(state, {
        agentId, turnNumber, floor: 'output-grind', atLoop: state.loopCount,
        content: result.toolCalls.length > 0
          ? '[System: Your last response was CUT OFF by the output limit, so its tool call did NOT run and nothing was sent. Do not shorten the work. '
            + 'Build it in a file one part per step (file_write the first part, file_append each next part), then send a short message giving the path.]'
          : (result.content ?? '').trim() ? '[System: Your last reply was CUT OFF by the output limit; what you wrote so far did not reach anyone. '   // a cut with content
            + 'Put it in a file: file_write what you have, file_append the rest a part at a time, then send the path.]'
          : '[System: Your last response used your ENTIRE output budget thinking and produced no tool call and no answer, so none of it reached anyone. '
            + 'Do not plan further. Take the single next concrete step now: make ONE tool call, or give the short answer you already have. Keep it brief.]',
      }, { broadcast });
      return continueLoop(state);
    }
    // A second grind after the steer: the person is told, the ask is re-armed so the drain re-serves it,
    // and the turn exits with the reason.
    logger.warn('v2: the output budget was spent grinding a SECOND time after the steer — giving up on this turn', {
      loopCount: state.loopCount, stopReason: result.stopReason,
    }, agentId);
    state = advance(state, { steerQueue: clearSteerQueueFor(state.steerQueue, EMPTY_LADDER_FAMILY) });
    broadcast({
      type: 'chat:error', cardClass: 'informational',
      agentId,
      error: 'Agent kept thinking until it ran out of room, twice, without answering. Send your message again to retry.',
      code: 'MODEL_FAILED',
      severity: 'warning',
      retryable: true,
    });
    reArmIfStrandedNoAnswer();
    return requestExit(state, 'output-grind-gave-up');
  }

  if (result.toolCalls.length === 0 && (!result.content || result.content.trim().length === 0)) {
    // The required reply came back empty: no retry, the turn ends and finalize holds the request.
    if (ctx.turnCtx.forcedReplySpent) return requestExit(state, 'forced-reply-empty');
    // Who is waiting, read once for the whole ladder and for every model, not only reasoning ones.
    const contract = contractForConfiguredModel(ctx.configuredModelId);
    const startAckOwed =
      (ctx.turnCtx.startAckSteerRequested || ctx.turnCtx.startAckSteerArmedThisTurn)
      && !ctx.turnCtx.engineStartAckDeliveredThisTurn;
    const owesAPerson =
      !ctx.isA2ATurn && !ctx.isEngineTurn && !ctx.counterpartyIsAgentSender
      && (startAckOwed || ctx.hasUnansweredUser || !!ctx.triggerRow);   // `undefined` when nobody waits

    if (state.toolCallsExecutedThisTurn > 0) {
      // A thinking model that owed a person a reply may have answered in its reasoning channel instead;
      // that spends the ladder's one silent retry (the same `retriedEmptyResponse` latch).
      const reasoningBody = (result.reasoningContent ?? '').trim();

      if (
        contract.answersInReasoning
        && owesAPerson
        && reasoningBody.length > 0
        && !state.retriedEmptyResponse
        && contract.emptyRetryBudget > 0
      ) {
        logger.warn('v2: answer-in-wrong-channel — this turn owed a person a reply, returned no visible content, and left a substantive body in the reasoning channel; spending the ladder\'s silent retry', {
          reason: 'answer-in-wrong-channel',
          loopCount: state.loopCount, stopReason: result.stopReason,
          reasoningChars: reasoningBody.length,
          owedVia: startAckOwed ? 'start-ack' : (ctx.hasUnansweredUser ? 'unanswered-user' : 'trigger-row'),
          contract: contract.id, emptyRetryBudget: contract.emptyRetryBudget,
        }, agentId);
        state = advance(state, { retriedEmptyResponse: true });
        return continueLoop(state);
      }
      // Work done with nobody waiting is a clean exit; an owed person falls into the ladder below.
      if (!owesAPerson) return requestExit(state, 'empty-response-after-tools');
    }
    // Silent retry first, since many empties are transient; a contract `emptyRetryBudget` of 0 forbids it.
    if (!state.retriedEmptyResponse && contract.emptyRetryBudget > 0) {
      logger.warn('v2: model returned empty response, retrying silently', {
        loopCount: state.loopCount, stopReason: result.stopReason,
      }, agentId);
      state = advance(state, { retriedEmptyResponse: true });
      return continueLoop(state);
    }
    // Silence to another Dojo box is an allowed answer: no nudge, no toast; finalize settles its request.
    if (ctx.counterpartyIsAgentSender) return requestExit(state, 'empty-response-peer-box');
    // A person still owed is answered by the required reply at the loop's exit, where one follows.
    const followed = replyCanBeRequired(ctx.latestUserSource, ctx.inboundChannel, ctx.counterpartyIsAgentSender);
    if (owesAPerson && followed) return requestExit(state, 'empty-response-owed');
    // Then one explicit nudge, as a steer.
    if (!steerFired(state.steerQueue, 'empty-response')) {
      logger.warn('v2: model returned empty after silent retry, nudging', {
        loopCount: state.loopCount, stopReason: result.stopReason,
      }, agentId);
      state = persistEngineSteer(state, {
        agentId, turnNumber, floor: 'empty-response', atLoop: state.loopCount,
        content: `[System: You returned an empty response. Please respond to ${userWords(ctx.turnCtx.address)}'s last message or call a tool to continue your task. If you are finished, say so clearly.]`,
      }, { broadcast });
      return continueLoop(state);
    }
    logger.warn('v2: model returned empty after nudge, breaking', {
      loopCount: state.loopCount, stopReason: result.stopReason,
    }, agentId);
    // Abandon only this ladder's own steers (recorded); other floors' steers stay queued.
    state = advance(state, { steerQueue: clearSteerQueueFor(state.steerQueue, EMPTY_LADDER_FAMILY) });
    broadcast({
      type: 'chat:error', cardClass: 'informational',
      agentId,
      error: 'Agent gave an empty reply. Send your message again to retry.',
      code: 'MODEL_FAILED',
      severity: 'warning',
      retryable: true,
    });
    // Re-arm the human ask so the drain re-serves it; guarded so a turn with any answer or side effect is not.
    reArmIfStrandedNoAnswer();
    return requestExit(state, 'empty-response-gave-up');
  }

  return proceed(state);
}
