// ════════════════════════════════════════
// PHASE-6 T6 (CUT 8) — THE OWED MID-TURN INTERRUPT (F3), moved byte-faithfully out of
// `loop.ts`'s `postCallClassify` span: a person who spoke WHILE the turn was running is
// owed an answer before the turn is allowed to end, and this is the re-prompt that gets
// them one.
//
// It opens with a TOMBSTONE that is kept deliberately — the same-turn scaffold close
// (`closeEngineScaffoldSameTurn`) died with the empty-project machine, and the note
// stays because a removal that cannot say what it removed comes back. `MAX_TOOL_LOOPS`
// is PASSED rather than moved: it has readers outside this span.
// ════════════════════════════════════════

import { v4 as uuidv4 } from 'uuid';
import { createLogger } from '../../../../logger.js';
import { insertEngineEventIfAbsent } from '../../../../memory/message-store.js';
import { advance, type AgentTurnState } from '../../state.js';
import { enqueueSteer, steerFired } from '../../steer-queue.js';
import { getOwedMidTurnArrivals } from '../../counterparty.js';
import { continueLoop, proceed, type StepOutcome } from '../step-outcome.js';
import type { PostCallClassifyContext, PostCallScratch } from './index.js';

const logger = createLogger('v2-loop');

/** The owed mid-turn interrupt re-prompt. */
export async function runOwedInterrupt(
  state: AgentTurnState,
  ctx: PostCallClassifyContext,
  sc: PostCallScratch,
): Promise<StepOutcome> {
  const {
    agentId, chosenConvKey, counterparty, isEngineTurn, maxToolLoops, turnCtx,
    turnNumber, turnStartedAt,
  } = ctx;
  const MAX_TOOL_LOOPS = maxToolLoops;
  const { persistedContent } = sc;
  // ── THE SAME-TURN SCAFFOLD CLOSE IS GONE (PHASE-2 T8c item 3) ──
  // `closeEngineScaffoldSameTurn` and this call site both die with the empty-project
  // machine, exactly as the plan's Step 4 says. The turn-start classifier no longer
  // opens a project+task before the model has done anything, so there is no pre-emptive
  // scaffold to dangle `in_progress` on a read-only turn and become a ghost-done
  // re-delivery. The >=6 floor's row describes work that DEMONSTRABLY happened (six
  // real tool calls), so closing it on the strength of a reply would be the engine
  // adjudicating success — the thing the two-key contract exists to refuse.
  // requirement preserved: an engine-opened row cannot dangle. Three surviving
  // mechanisms see it — the going-idle close-out gate, the PM ladder's
  // delivery-evidence consult (strike 1 steers the close, strike 2 closes on the
  // receipt), and the reaper. What is gone is the one path that bypassed all three.

  // ── F3: owed mid-turn interrupt re-prompt ──
  // A quick question that lands WHILE a turn is running is NOT an interrupt:
  // its wakeup row sits conv_key NULL and rides into the running turn's
  // per-iteration reassembled tail (runtime.ts). At teardown,
  // the assembled-context set covers every same-conversation user row that was in
  // the answered context (conv_key NULL, created_at <= the final assembly) so a
  // burst can't earn a duplicate answer, a requirement we KEEP intact. The gap
  // it leaves: "in context when we answered" is treated as "was answered", so a
  // DISTINCT factual question that arrived mid-task is claimed as served and
  // never answered anywhere (the weak model absorbs the interruption silently).
  //
  // Fix the CAUSE, don't suppress the claim: on a user turn that produced a
  // reply, give the model exactly ONE more round to address any owed mid-turn
  // arrival BEFORE the same teardown claim marks it served. The [no-reply]
  // escape is what keeps this from creating a NEW duplicate-answer problem when
  // the main reply already covered it. getOwedMidTurnArrivals scopes to the
  // EXACT set the claim will take (same conv-scoping + window) narrowed to
  // mid-turn arrivals (created_at > turnStartedAt), so the trigger and any
  // pre-turn burst siblings (answered as the turn's subject) are excluded.
  //
  // Placed AFTER the F2.1 scaffold close so that close still runs on THIS
  // iteration's reply (it must not be deferred into a possible [no-reply] extra
  // round), and it yields to the going-idle hardcap above (which breaks first on
  // a worked-task-with-danglers turn) so this never fights that reconciliation.
  // One-shot (the queue's own latch for `owed-interrupt`) and skipped at the loop cap, so it
  // can neither spin the loop nor push past MAX_TOOL_LOOPS.
  if (
    counterparty.kind === 'user' &&
    !isEngineTurn &&
    !steerFired(state.steerQueue, 'owed-interrupt') &&
    persistedContent && persistedContent.trim().length > 0 &&
    state.loopCount < MAX_TOOL_LOOPS &&
    turnCtx.lastAssembledAtIso &&
    chosenConvKey &&
    chosenConvKey !== 'engine'
  ) {
    let owed = getOwedMidTurnArrivals(agentId, chosenConvKey, turnStartedAt, turnCtx.lastAssembledAtIso);
    if (owed.length > 0) {
      // Belt-and-suspenders on top of the query's origin_kind='engine' filter:
      // never quote human text that merely opens with an engine tag ([System:,
      // [A2A:, [SOURCE: ...) back into a model-visible re-prompt.
      const { looksLikeEngineMessage } = await import('../../classifiers/multistep.js');
      owed = owed.filter((m) => !looksLikeEngineMessage(m.content));
    }
    if (owed.length > 0) {
      const quoted = owed
        .slice(0, 3)
        .map((m) => `"${m.content.replace(/\s+/g, ' ').trim().slice(0, 200)}"`)
        .join('; ');
      const itThem = owed.length === 1 ? 'it' : 'them';
      const rePrompt = (
        `[System] While you were working, the user also sent: ${quoted}. ` +
        `Reply ONLY to ${itThem}, in one or two sentences. ` +
        `Answer from what you already know, with at most one quick lookup if truly needed. ` +
        `Do not re-run the tools you used for the main task; that work is done and delivered. ` +
        `Do NOT repeat, summarize, or re-deliver ANY part of your earlier reply; the user already has it. ` +
        `If your earlier reply already answered ${itThem}, reply exactly [no-reply].`
      );
      const rePromptId = uuidv4();
      try {
        // Model-visible engine channel, same pattern as the thrash steer and the
        // auto-scaffold note: an origin_kind='engine' row (EVENTS lane surfaces
        // it) with the 'engine-steer' conv_key sentinel so it can never be picked
        // as a pending engine event, PLUS a queue entry so the steer reaches the
        // model on the very next iteration. Label form ([System] body) so the
        // events-lane leading-bracket strip keeps the body.
        insertEngineEventIfAbsent({
          work: null,
          id: rePromptId,
          agentId,
          content: rePrompt,
          sourceAgentId: null,
          originIntent: 'owed_interrupt',
          turnNumber,
        });
      } catch { /* best effort */ }
      state = advance(state, { steerQueue: enqueueSteer(state.steerQueue, { floor: 'owed-interrupt', content: rePrompt, atLoop: state.loopCount }) });
      logger.info('v2 owed-interrupt re-prompt: a mid-turn user message was assembled but may be unanswered; giving the model one more round before the teardown claim marks it served', {
        agentId, turnNumber, owedCount: owed.length, convKey: chosenConvKey,
      }, agentId);
      return continueLoop(state); // exactly one more round for the model to answer the owed ask
    }
  }

  return proceed(state);
}
