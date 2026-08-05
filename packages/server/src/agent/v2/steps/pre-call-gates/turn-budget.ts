// ════════════════════════════════════════
// PHASE-6 T3 — preCallGates, part 2 of 3: THE TURN-TIME BUDGET.
//
// Relocated verbatim from `agent/v2/loop.ts` (`:2912`–`:3013` at `c1ad4d5`).
//
// The turn does not HALT at 15 minutes — it checkpoints: force a compaction, hand
// the rebuilt context this turn's own receipts, tell the person, and queue a wakeup
// so the work resumes on a fresh turn. Three of those are separable and one is not:
// the RECAP exists because a mid-turn rebuild can evict the model's own in-turn
// speech while the trigger stays pinned, so every rebuilt context read as "the user
// just said this and I have not responded" (2026-07-23, the owner's .19 transcript:
// seven near-identical apologies in one long turn).
//
// Its requirement landed as a test BEFORE this file existed — six clauses in
// `agent/v2/__tests__/integration.test.ts`, green on the unmoved tree, including
// the positive control that a turn inside the budget recaps nothing.
// ════════════════════════════════════════

import { v4 as uuidv4 } from 'uuid';
import { createLogger } from '../../../../logger.js';
import { getContextWindow } from '../../../model.js';
import { checkAndCompact } from '../../../../memory/compaction.js';
import { insertMessageIfAbsent } from '../../../../memory/message-store.js';
import { turnContinuationCounts, pendingWakeups } from '../../../shared-state.js';
import { advance, type AgentTurnState } from '../../state.js';
import { enqueueSteer } from '../../steer-queue.js';
import { proceed, requestExit, type StepOutcome } from '../step-outcome.js';
import type { PreCallGatesContext, PreCallGatesExitReason } from './index.js';

const logger = createLogger('v2-loop');

const TURN_TIME_BUDGET_MS = 15 * 60 * 1000;    // matches v1, 15 min/turn
const MAX_TURN_AUTO_CONTINUATIONS = 3;         // matches v1

/**
 * The turn-time budget checkpoint. Returns `proceed` while the turn is inside its
 * budget; otherwise the turn ends, either parked for a continuation or stopped at
 * the ladder's cap.
 */
export async function runTurnTimeBudget(
  state: AgentTurnState,
  ctx: PreCallGatesContext,
): Promise<StepOutcome> {
  const {
    agentId, turnNumber, configuredModelId, broadcast, stashContinuationIfHuman,
    deferredDeliveredByAck, engineStartAckDeliveredThisTurn,
  } = ctx;

  // ── F10 note: the start-ack floor is the wall-clock timer armed at turn
  // start (search "F10: wall-clock start-ack timer"), NOT a loop-boundary
  // check here. A boundary check could only fire between model rounds, and
  // a single slow first round pushed the ack to seconds before the reply
  // (observed live), while wakeup/drain turns with a user counterparty but
  // no waiting human got a stray "On it." attached to nothing. ──

  // ── Turn time budget, auto-continue, don't halt ──
  // (Matches v1 runtime.ts:884-919.) When a turn runs longer than 15 min,
  // force a compaction and queue a wakeup so the agent picks up where it
  // left off. After MAX_TURN_AUTO_CONTINUATIONS consecutive checkpoints
  // we give up, usually indicates a stuck loop.
  if (Date.now() - state.turnStartMs > TURN_TIME_BUDGET_MS) {
    const elapsedMin = Math.round((Date.now() - state.turnStartMs) / 60000);
    const continuationCount = (turnContinuationCounts.get(agentId) ?? 0) + 1;

    if (continuationCount > MAX_TURN_AUTO_CONTINUATIONS) {
      turnContinuationCounts.delete(agentId);
      logger.error('v2 turn auto-continuation cap reached, stopping', {
        elapsedMin, continuationCount, max: MAX_TURN_AUTO_CONTINUATIONS, agentId,
      }, agentId);
      const totalMin = (MAX_TURN_AUTO_CONTINUATIONS + 1) * (TURN_TIME_BUDGET_MS / 60000);
      const stuckMsg = (
        `[System: This task has been running for about ${totalMin} minutes without finishing. ` +
        `Pausing, this usually means a stuck loop, an over-scoped task, or a slow model. ` +
        `Send a follow-up to resume, or break the work into smaller pieces.]`
      );
      const stuckId = uuidv4();
      insertMessageIfAbsent({ id: stuckId, agentId, role: 'system', content: stuckMsg, turnNumber });
      broadcast({
        type: 'chat:message',
        agentId,
        message: {
          id: stuckId, agentId, role: 'system' as const,
          content: stuckMsg,
          tokenCount: null, modelId: null, cost: null, latencyMs: null,
          createdAt: new Date().toISOString(),
        },
      });
      return requestExit(state, 'turn-continuation-cap' satisfies PreCallGatesExitReason);
    }

    turnContinuationCounts.set(agentId, continuationCount);
    logger.warn('v2 turn time budget reached, auto-continuing with forced compaction', {
      elapsedMin, continuationCount, agentId,
    }, agentId);

    // Force compaction so next turn starts with summarized history.
    try {
      const effectiveModel =
        state.modelId === '__auto__' ? configuredModelId : state.modelId;
      await checkAndCompact(agentId, effectiveModel, getContextWindow(effectiveModel), { force: true });
      // In-turn recap after a MID-TURN compaction (2026-07-23, owner .19
      // transcript: seven near-identical apologies in one long turn). A
      // rebuild can evict the model's own in-turn speech (giant tool
      // payloads eat the fresh tail) while the trigger stays pinned, so
      // every rebuilt context read as "the user just said this and I have
      // not responded", and the model re-acknowledged from scratch each
      // time. The engine holds the receipts of what this turn already
      // did; hand them over so the rebuilt context cannot forget.
      // T6: slot-gate dead with the flag. §T0-PINS F's `:2871`, the named victim.
      {
        // PHASE-6 T13 (CUT 3's H1): the number is the TURN's, because the sentence says
        // "so far this turn". It was `state.toolCalls.length` — the LAST model response's
        // batch, which `callLLM` overwrites from `result.toolCalls` every round — so a turn
        // of two rounds of one tool each said "so far this turn ... 1".
        //
        // `toolResults` is the turn's own ledger and it is the right number here for a
        // measured reason, not an aesthetic one: it has ONE writer (`steps/execute/index.ts`
        // concatenates the round's results once, AFTER the batch settles), it is never reset
        // mid-turn, and it is therefore immune to the parallel-safe batch's known
        // last-writer-wins semantics — which `toolCallsExecutedThisTurn` is NOT. Measured:
        // one round of two parallel `file_read`s executes twice and leaves that counter at
        // 1 (CUT 7's §13 note, and the span's own comment: those parallel writes "can
        // silently fail to stick"). Swapping one wrong number for another is not a fix.
        const recap =
          `[Engine recap: memory was just compacted MID-TURN. This is still the SAME turn. So far this turn you have made ${state.toolResults.length} tool call(s)` +
          (state.surfacedReplyThisTurn || deferredDeliveredByAck || engineStartAckDeliveredThisTurn
            ? ' and the user has ALREADY heard your acknowledgment'
            : '') +
          '. Continue the work exactly where it stands. Do NOT re-introduce yourself, re-acknowledge, or re-apologize; pick up from the last tool result.]';
        state = advance(state, { steerQueue: enqueueSteer(state.steerQueue, { floor: 'compaction-recap', content: recap, atLoop: state.loopCount }) });
        logger.info('v2 mid-turn compaction recap injected (turn continuity across the rebuild)', {
          agentId, turnNumber, toolCallsSoFar: state.toolResults.length,
        }, agentId);
      }
    } catch (compErr) {
      logger.warn('v2 forced compaction at turn-budget checkpoint failed', {
        agentId, error: compErr instanceof Error ? compErr.message : String(compErr),
      }, agentId);
    }

    const sysMsg = (
      `[System: This turn ran for ${elapsedMin} minutes. Pausing here and continuing on a fresh turn ` +
      `(${continuationCount} of ${MAX_TURN_AUTO_CONTINUATIONS}). ` +
      `Your earlier conversation has been summarized, pick up where you left off. ` +
      `Check work_update(action="list") for the task you were working on; do not start over.]`
    );
    const sysMsgId = uuidv4();
    insertMessageIfAbsent({ id: sysMsgId, agentId, role: 'system', content: sysMsg, turnNumber });
    broadcast({
      type: 'chat:message',
      agentId,
      message: {
        id: sysMsgId, agentId, role: 'system' as const,
        content: sysMsg,
        tokenCount: null, modelId: null, cost: null, latencyMs: null,
        createdAt: new Date().toISOString(),
      },
    });
    // Queue wakeup so handleMessage's finally fires the loop again
    stashContinuationIfHuman(); // C3: carry the human conversation into the continuation
    pendingWakeups.add(agentId);
    return requestExit(state, 'turn-time-budget' satisfies PreCallGatesExitReason);
  }
  return proceed(state);
}
