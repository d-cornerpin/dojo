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

  // ════════════════════════════════════════════════════════════════════════════════════
  // SWEEP-A TB8 JOB 1 — THE GRIND RUNG. The owner's question, in his words: *"Should an
  // agent get stuck grinding? How do we detect and restart?"*
  //
  // THE CLASS, from the durable sink: a call that reasons endlessly, makes no tool call,
  // produces no deliverable, and runs out the model's ENTIRE output budget. 17 of 19,124
  // completed calls carrying a known cap (2026-07-27 → 2026-08-06, all four batteries)
  // reached their model's own `max_output_tokens`, on two different models and two
  // different caps — 119 s to 418 s each, T14's recorded pair and BATTERY4's instance
  // among them. Both bounds the brief named were tested against that corpus and both are
  // REFUSED with their numbers (see `__tests__/output-grind.test.ts`): duration orders the
  // populations wrong, and every sub-cap token threshold sits inside 1% of a legitimate
  // call. The cap the product already configures per model is the only thing that
  // separates them categorically — 17/17 caught, 0 of 19,107 false — and the PROVIDER
  // reports the crossing, so this is a fact rather than a threshold.
  //
  // WHY IT WAS NEVER SEEN: `agent/model.ts` fabricated `stopReason` from
  // `toolCalls.length` and threw the provider's `finish_reason` away, so this classifier —
  // whose `TRUNCATION_STOP_REASONS` has held `'length'` since it was written — could never
  // fire on the floor-model path. TB8 fixes that at the source; this rung is what the
  // signal now reaches.
  //
  // WHY IT IS ITS OWN RUNG, ABOVE THE LADDER BELOW: without it a grind is diagnosed as a
  // plain empty response and answered with a SILENT RETRY, then a nudge that says "you
  // returned an empty response" — three full output budgets and a name for the wrong
  // thing. And a grind that managed a few words before the budget ran out never reached
  // this module at all: the guard below requires empty content, so the engine persisted a
  // mid-sentence fragment as the agent's answer and ended the turn.
  //
  // NO NEW MECHANISM AND NO NEW VOICE: the steer is the existing queue (model-visible,
  // OR2 — the engine never speaks to the person as the agent), it is bounded at ONE by
  // that queue's own per-floor latch, and the give-up rung is the EXISTING failure surface
  // below, reached by falling into it rather than by composing a second one. The cache
  // tenet holds: a steer rides the assembled tail, nothing here touches the prompt prefix.
  // ════════════════════════════════════════════════════════════════════════════════════
  const grindTrunc = outputTruncationClassifier({
    stopReason: result.stopReason,
    contentLength: result.content?.length ?? 0,
    currentBudget: state.outputTokensEscalated,
  });
  if (grindTrunc.truncated && result.toolCalls.length === 0) {
    if (!steerFired(state.steerQueue, 'output-grind')) {
      logger.warn('v2: the model spent its whole output budget with no tool call — steering, not re-running', {
        loopCount: state.loopCount, stopReason: result.stopReason,
        contentChars: result.content?.length ?? 0,
      }, agentId);
      state = advance(state, {
        steerQueue: enqueueSteer(state.steerQueue, {
          floor: 'output-grind', atLoop: state.loopCount,
          content:
            '[System: Your last response used your ENTIRE output budget thinking and produced '
            + 'no tool call and no answer, so none of it reached anyone. Do not plan further. '
            + 'Take the single next concrete step now: make ONE tool call, or give the short '
            + 'answer you already have. Keep it brief.]',
        }),
      });
      return continueLoop(state);
    }
    // Rung 2: it happened again inside the same turn, after being told. Two full budgets is
    // the bound — the person is told on the surface the platform already owns, the ask is
    // re-armed so the drain re-serves it, and the turn record carries the reason.
    logger.warn('v2: the output budget was spent grinding a SECOND time after the steer — giving up on this turn', {
      loopCount: state.loopCount, stopReason: result.stopReason,
    }, agentId);
    state = advance(state, { steerQueue: clearSteerQueue(state.steerQueue) });
    broadcast({
      type: 'chat:error',
      agentId,
      error: 'Agent kept thinking until it ran out of room, twice, without answering. Send your message again to retry.',
      code: 'MODEL_FAILED',
      severity: 'warning',
      retryable: true,
    });
    reArmIfStrandedNoAnswer();
    return requestExit(state, 'output-grind-gave-up');
  }

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
