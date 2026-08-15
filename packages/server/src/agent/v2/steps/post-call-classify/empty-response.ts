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
import { contractForConfiguredModel } from '../../../model.js';
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
      // ════════════════════════════════════════════════════════════════════════════════
      // HL2 — THE ANSWER THAT WENT INTO THE WRONG CHANNEL.
      //
      // This exit is a DELIBERATE not-a-failure: v1 line 1167-1171, "the agent did work
      // and has nothing more to say." It has never consulted `reasoning_content`, and
      // that is the gap. DeepSeek's own harness says so in its source
      // (`llm-deepseek/src/serialize.ts:88-95`): the model *"can answer entirely in the
      // reasoning channel, e.g. a v4-flash greeting"* — and dsh treats a content-less
      // completion as RETRYABLE. A turn that owes a person a reply, returns nothing
      // visible, and leaves a body in its hidden channel did not have nothing to say. It
      // said it into a channel nobody reads.
      //
      // NO NEW MECHANISM, NO NEW RUNG, NO NEW VOICE, NO NEW PREDICATE (the owner's
      // census rule):
      //   • the rung is the EXISTING silent retry twenty lines below, reached with the
      //     SAME `retriedEmptyResponse` latch, so a turn still gets exactly ONE silent
      //     re-run no matter which door asked for it;
      //   • the owed test is the EXISTING start-ack owed pair and the EXISTING
      //     unanswered-person flags, read, not re-derived;
      //   • whether the model can even do this is a declared CONTRACT field
      //     (`answersInReasoning`, HL1) — a non-thinking model can never take this branch;
      //   • the bound is the contract's `emptyRetryBudget`, which is where the ladder's
      //     "one silent retry" has always lived, now said out loud instead of implied by
      //     a boolean.
      //
      // SUBSTANTIVE MEANS NON-BLANK, and that is deliberate rather than lazy. dsh retries
      // on ANY content-less completion; this branch is already three predicates narrower
      // (a person must be owed, the model must be one that answers in reasoning, and the
      // turn must have run tools). A character threshold on top of that would be a number
      // nobody could defend from the record.
      //
      // WHAT IS BYTE-IDENTICAL: a turn with nobody owed; a turn on a model whose contract
      // says `answersInReasoning: false`; a turn whose reasoning channel is blank; and
      // the `[no-reply]` sentinel, which is VISIBLE CONTENT by design and never reaches
      // this guard at all.
      // ════════════════════════════════════════════════════════════════════════════════
      const contract = contractForConfiguredModel(ctx.configuredModelId);
      const startAckOwed =
        (ctx.turnCtx.startAckSteerRequested || ctx.turnCtx.startAckSteerArmedThisTurn)
        && !ctx.turnCtx.engineStartAckDeliveredThisTurn;
      const owesAPerson =
        !ctx.isA2ATurn && !ctx.isEngineTurn && !ctx.counterpartyIsAgentSender
        && (startAckOwed || ctx.hasUnansweredUser || ctx.triggerRow !== null);
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
      // v1 line 1167-1171: agent did work and has nothing more to say.
      return requestExit(state, 'empty-response-after-tools');
    }
    // No tools called and no text, empty response. v1 runtime.ts:1166-1199
    // does a 3-phase fallback before giving up. Many empties are transient
    // (streaming hiccup, model hesitation) and resolve on a silent retry.
    // Phase 1: silent retry (no nudge, just re-run the model).
    // HL1/HL2: how many silent re-runs a model may have is the contract's
    // `emptyRetryBudget`. It is seeded at 1 for every configured model, which is exactly
    // what this boolean latch has always meant — the field says it out loud so a model
    // that must never be silently re-run can be declared instead of special-cased.
    if (!state.retriedEmptyResponse && contractForConfiguredModel(ctx.configuredModelId).emptyRetryBudget > 0) {
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
