// ════════════════════════════════════════
// PHASE-6 T6 (CUT 8) — THE EMPTY-RESPONSE LADDER, moved byte-faithfully out of
// `loop.ts`'s `postCallClassify` span. Three rungs and two ways out, unchanged:
// escalate-and-retry on a truncation, a silent retry, a nudge, then give up with a
// toast — and, before either exit, the two cases that are NOT failures (the model
// did work and has nothing to say; the truncation is recoverable).
//
// FIVE OF THIS TRANCHE'S TWENTY-FOUR CONTROL-FLOW CONVERSIONS ARE HERE, the densest
// stretch in the span: three `continue`s and both of the span's early `break`s. A
// module cannot break its caller's loop, so each one became the exit-request channel
// (`steps/step-outcome.ts`) with the reason the comment beside it already gave.
// ════════════════════════════════════════

import { broadcast } from '../../../../gateway/ws.js';
import { createLogger } from '../../../../logger.js';
import { advance, type AgentTurnState } from '../../state.js';
import { clearSteerQueue, enqueueSteer, steerFired } from '../../steer-queue.js';
import { outputTruncationClassifier } from '../../classifiers/output.js';
import { continueLoop, proceed, requestExit, type StepOutcome } from '../step-outcome.js';
import type { PostCallClassifyContext } from './index.js';

const logger = createLogger('v2-loop');

/** The empty-response ladder. `proceed` means the response was not empty. */
export function runEmptyResponse(state: AgentTurnState, ctx: PostCallClassifyContext): StepOutcome {
  const { agentId, result, reArmIfStrandedNoAnswer } = ctx;

  // Empty response handling, v1 has 3-phase retry. Phase 2 baseline:
  // single output-truncation check; if not truncated and no text/tools,
  // surface as toast and break.
  if (result.toolCalls.length === 0 && (!result.content || result.content.trim().length === 0)) {
    const trunc = outputTruncationClassifier({
      stopReason: result.stopReason,
      contentLength: 0,
      currentBudget: state.outputTokensEscalated,
    });
    if (trunc.truncated && trunc.escalateTo !== null) {
      // Output was truncated, escalate budget and retry.
      state = advance(state, { outputTokensEscalated: trunc.escalateTo });
      return continueLoop(state);
    }
    // Clean end-of-turn after tools, legitimate exit, no error.
    if (state.toolCallsExecutedThisTurn > 0) {
      // v1 line 1167-1171: agent did work and has nothing more to say.
      return requestExit(state, 'empty-response-after-tools');
    }
    // No tools called and no text, empty response. v1 runtime.ts:1166-1199
    // does a 3-phase fallback before giving up. Many empties are transient
    // (streaming hiccup, model hesitation) and resolve on a silent retry.
    // Phase 1: silent retry (no nudge, just re-run the model).
    if (!state.retriedEmptyResponse) {
      logger.warn('v2: model returned empty response, retrying silently', {
        loopCount: state.loopCount, stopReason: result.stopReason,
      }, agentId);
      state = advance(state, { retriedEmptyResponse: true });
      return continueLoop(state);
    }
    // Phase 2: explicit nudge, enqueue a [System: ...] note
    // so the assemble phase wraps it as a synthetic user message next turn.
    if (!steerFired(state.steerQueue, 'empty-response')) {
      logger.warn('v2: model returned empty after silent retry, nudging', {
        loopCount: state.loopCount, stopReason: result.stopReason,
      }, agentId);
      state = advance(state, {
        steerQueue: enqueueSteer(state.steerQueue, {
          floor: 'empty-response', atLoop: state.loopCount,
          content: "[System: You returned an empty response. Please respond to the user's last message or call a tool to continue your task. If you are finished, say so clearly.]",
        }),
      });
      return continueLoop(state);
    }
    // Phase 3: give up, toast the user, no DB changes.
    logger.warn('v2: model returned empty after nudge, breaking', {
      loopCount: state.loopCount, stopReason: result.stopReason,
    }, agentId);
    // The turn is giving up: nothing still waiting can be delivered, so drop the
    // queue. The entries are recorded as abandoned, never silently forgotten.
    state = advance(state, { steerQueue: clearSteerQueue(state.steerQueue) });
    broadcast({
      type: 'chat:error',
      agentId,
      error: 'Agent gave an empty reply. Send your message again to retry.',
      code: 'MODEL_FAILED',
      severity: 'warning',
      retryable: true,
    });
    // C4: this give-up break is the clean-retry case, reached only when NO tools
    // executed this turn (the empty-after-tools break above catches the tools case)
    // and the model produced empty text 3x. Re-arm the human ask so the drain re-serves
    // it (the toast still tells the user they can also resend). Guarded so it never
    // re-arms a turn that produced any answer/side effect.
    reArmIfStrandedNoAnswer();
    return requestExit(state, 'empty-response-gave-up');
  }

  return proceed(state);
}
