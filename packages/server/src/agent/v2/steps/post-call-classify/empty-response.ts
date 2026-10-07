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
import { askIdForMessage } from '../../../../work/store.js';
import { recordFloorGhost } from '../../floor-ghost.js';
import { advance, type AgentTurnState } from '../../state.js';
import { persistEngineSteer } from '../../engine-steer.js';
import { clearSteerQueueFor, steerFired, type SteerFloorId } from '../../steer-queue.js';
import { outputTruncationClassifier } from '../../classifiers/output.js';
import { continueLoop, proceed, requestExit, type StepOutcome } from '../step-outcome.js';
import type { PostCallClassifyContext } from './index.js';

const logger = createLogger('v2-loop');

/**
 * THE LADDER'S OWN FAMILY — the only entries its give-up rungs may abandon (HL4 2b).
 *
 * Two rungs, one ladder, and its own header already says why they are two rungs and not
 * one (`:52-58`). What they share is a subject: THIS model call produced nothing usable.
 * Every other floor in the queue is speaking about something else, and a rung that gives
 * up on its own diagnosis has no standing to give up on theirs — a priority-10 truth
 * guard filed earlier in the same turn was abandoned undelivered by exactly that reach.
 */
const EMPTY_LADDER_FAMILY: readonly SteerFloorId[] = ['output-grind', 'empty-response'];

/** The empty-response ladder. `proceed` means the response was not empty. */
export function runEmptyResponse(state: AgentTurnState, ctx: PostCallClassifyContext): StepOutcome {
  const { agentId, turnNumber, result, reArmIfStrandedNoAnswer } = ctx;

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
      // HL3: the RC-19 door — an unrecorded steer diagnosing an invisible failure class
      // repeats the defect one level up.
      state = persistEngineSteer(state, {
        agentId, turnNumber, floor: 'output-grind', atLoop: state.loopCount,
        content:
          '[System: Your last response used your ENTIRE output budget thinking and produced '
          + 'no tool call and no answer, so none of it reached anyone. Do not plan further. '
          + 'Take the single next concrete step now: make ONE tool call, or give the short '
          + 'answer you already have. Keep it brief.]',
      }, { broadcast });
      return continueLoop(state);
    }
    // Rung 2: it happened again inside the same turn, after being told. Two full budgets is
    // the bound — the person is told on the surface the platform already owns, the ask is
    // re-armed so the drain re-serves it, and the turn record carries the reason.
    logger.warn('v2: the output budget was spent grinding a SECOND time after the steer — giving up on this turn', {
      loopCount: state.loopCount, stopReason: result.stopReason,
    }, agentId);
    state = advance(state, { steerQueue: clearSteerQueueFor(state.steerQueue, EMPTY_LADDER_FAMILY) });
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
    // ════════════════════════════════════════════════════════════════════════════════════
    // WHO IS WAITING — HOISTED, because the WHOLE LADDER needs it and not just the
    // wrong-channel door (t125, Q2 of the PM-cluster triage).
    //
    // THE DEFECT THIS MOVE REPAIRS: this predicate was computed twenty lines further down,
    // INSIDE the after-tools block, and then consulted only inside the `answersInReasoning`
    // gate — which is true for DeepSeek and false for every other model
    // (`agent/model-contract.ts`: `ANSWERS_IN_REASONING_MODELS = /deepseek/i`, and the base
    // contract's `answersInReasoning: false`). So on a Claude-backed agent the engine
    // computed "a person is waiting", discarded the fact, and ended the turn in total
    // silence. Field evidence: a PM agent ran two `history_search` calls, returned no text,
    // and the turn ended with nothing on the owner's screen — twice.
    //
    // It is the SAME predicate, read one scope up. Not re-derived, not widened: the start-ack
    // owed pair and the unanswered-person flags, exactly as HL2 wrote them.
    // ════════════════════════════════════════════════════════════════════════════════════
    const contract = contractForConfiguredModel(ctx.configuredModelId);
    const startAckOwed =
      (ctx.turnCtx.startAckSteerRequested || ctx.turnCtx.startAckSteerArmedThisTurn)
      && !ctx.turnCtx.engineStartAckDeliveredThisTurn;
    const owesAPerson =
      !ctx.isA2ATurn && !ctx.isEngineTurn && !ctx.counterpartyIsAgentSender
      && (startAckOwed || ctx.hasUnansweredUser || ctx.triggerRow !== null);

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
      // ════════════════════════════════════════════════════════════════════════════════
      // v1 line 1167-1171: "the agent did work and has nothing more to say" — TRUE ONLY
      // WHEN NOBODY IS WAITING (t125).
      //
      // A turn that owes a person a reply and comes back empty has not finished; it has
      // produced nothing. It is not a no-comment, and calling it one is what put the
      // owner's two `history_search` turns on screen as blank. So the owed case falls out
      // of this block into the ladder that already exists below — one silent retry, then
      // the one-shot `empty-response` steer, then the bounded give-up. ONE MODEL, ONE
      // LADDER: this exit is no longer a DeepSeek-only privilege, and nothing about which
      // provider is serving changes which door a silent turn walks out of.
      //
      // NO NEW MECHANISM, RUNG, VOICE OR PREDICATE: `owesAPerson` was already computed and
      // thrown away; the rungs below are the ones every other empty reply has always
      // walked; the bound is the contract's `emptyRetryBudget` plus the queue's own
      // per-floor latch, as before.
      // ════════════════════════════════════════════════════════════════════════════════
      if (!owesAPerson) return requestExit(state, 'empty-response-after-tools');
    }
    // No tools called and no text, empty response. v1 runtime.ts:1166-1199
    // does a 3-phase fallback before giving up. Many empties are transient
    // (streaming hiccup, model hesitation) and resolve on a silent retry.
    // Phase 1: silent retry (no nudge, just re-run the model).
    // HL1/HL2: how many silent re-runs a model may have is the contract's
    // `emptyRetryBudget`. It is seeded at 1 for every configured model, which is exactly
    // what this boolean latch has always meant — the field says it out loud so a model
    // that must never be silently re-run can be declared instead of special-cased.
    if (!state.retriedEmptyResponse && contract.emptyRetryBudget > 0) {
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
      state = persistEngineSteer(state, {
        agentId, turnNumber, floor: 'empty-response', atLoop: state.loopCount,
        content: "[System: You returned an empty response. Please respond to the user's last message or call a tool to continue your task. If you are finished, say so clearly.]",
      }, { broadcast });
      return continueLoop(state);
    }
    // Phase 3: give up, toast the user, no DB changes.
    logger.warn('v2: model returned empty after nudge, breaking', {
      loopCount: state.loopCount, stopReason: result.stopReason,
    }, agentId);
    // The turn is giving up on THIS LADDER, so its own entries are abandoned — recorded,
    // never silently forgotten. HL4 2b: it no longer speaks for the rest of the queue. A
    // guard about something the person was already told is not answered by an empty call.
    state = advance(state, { steerQueue: clearSteerQueueFor(state.steerQueue, EMPTY_LADDER_FAMILY) });
    // ══════════════════════════════════════════════════════════════════════════════════
    // THE HONEST END OF THE LADDER, WHEN A PERSON IS OWED (t125, OR2's last clause).
    //
    // A `chat:error` toast is a HEALTH SURFACE, not a reply: it is live-only, it leaves no
    // row, and a person who was elsewhere when it fired — or who reloads — sees a turn that
    // said nothing at all. That is the owner's symptom in one sentence, and it survives the
    // ungating above for the turn where the model stays empty all the way down.
    //
    // So the owed case ends the way every other ghosted floor in this engine ends, through
    // the mechanism that already exists for exactly this: `recordFloorGhost` — a durable
    // `role='system'` row in the PLATFORM's voice (never the agent's face, OR2), announced
    // on the wire beside the write, plus the health frame and a countable `floor_ghosted`
    // event on the ask. The sibling `handoff-floors.ts` calls it the same way, for the same
    // reason, with the same `askIdForMessage` lookup.
    //
    // ⚠ WHAT THIS DELIBERATELY DOES **NOT** DO, and the reason is a measured regression:
    // it does not `latchEngineCut`. The triage's clause asked for an engine-imposed exit
    // here so the re-serve ladder stops being charged — but `work/ask-settlement.ts:776`
    // reads `if (!engineCut && spent >= MAX_ASK_RE_SERVES) return standDownReServe(...)`,
    // i.e. an engine cut bypasses the stand-down ENTIRELY. A model that returns empty
    // returns empty again, so latching here would re-serve the same ask forever, three
    // model calls a cycle — the owner's own standing complaint (agents repeat themselves),
    // installed as an infinite loop. And `no_reply_intended` is HONEST at THIS rung in a
    // way it never was at the exit above: by here the model has been asked three times,
    // once explicitly, and has chosen silence every time — which is precisely what
    // `work/exit-attribution.ts` reserves the word for. The lie was the UNRETRIED exit, and
    // that is the one this file fixed.
    // ══════════════════════════════════════════════════════════════════════════════════
    if (owesAPerson) {
      const root = ctx.turnCtx.root;
      recordFloorGhost({
        agentId, turnNumber, floor: 'empty-response',
        workId: root?.kind === 'ask' ? askIdForMessage(root.id) : null,
        attempts: 1,
        ownerLine:
          'your agent returned an empty reply to your last message every time it was asked — '
          + 'including once after the engine told it to answer — so nothing was sent and the turn '
          + 'ended with no reply. Your message is still open; send it again to retry.',
        detail: { conv_key: ctx.chosenConvKey ?? null, model: contract.id },
      }, { broadcast });
    } else {
      broadcast({
        type: 'chat:error',
        agentId,
        error: 'Agent gave an empty reply. Send your message again to retry.',
        code: 'MODEL_FAILED',
        severity: 'warning',
        retryable: true,
      });
    }
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
