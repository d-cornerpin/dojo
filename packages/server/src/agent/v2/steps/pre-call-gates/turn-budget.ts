// ════════════════════════════════════════
// PHASE-6 T3 — preCallGates, part 2 of 3: THE TURN-TIME BUDGET.
//
// Relocated verbatim from `agent/v2/loop.ts` (`:2912`–`:3013` at `c1ad4d5`).
//
// The turn does not HALT at 15 minutes — it checkpoints: force a compaction, tell the
// person, and queue a wakeup so the work resumes on a fresh turn.
//
// HL4 STEP 2 (2d), 2026-08-15: there used to be a fourth thing here — an in-turn
// `compaction-recap` STEER handing the rebuilt context this turn's own receipts. It is
// RETIRED, with the driven measurement and the two homes its requirement moved to
// written out in full at the tombstone below. Read that before adding anything back.
//
// The requirements of what remains landed as tests BEFORE this file existed, in
// `agent/v2/__tests__/integration.test.ts`, including the positive control that a turn
// inside the budget compacts nothing.
// ════════════════════════════════════════

import { v4 as uuidv4 } from 'uuid';
import { createLogger } from '../../../../logger.js';
import { getContextWindow } from '../../../model.js';
import { checkAndCompact } from '../../../../memory/compaction.js';
import { insertMessageIfAbsent } from '../../../../memory/message-store.js';
import { turnContinuationCounts, queueSelfWake } from '../../../shared-state.js';
import { type AgentTurnState } from '../../state.js';
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
      // ════════════════════════════════════════════════════════════════════════════
      // TOMBSTONE — THE `compaction-recap` STEER, RETIRED HL4 STEP 2 (2d), 2026-08-15.
      //
      // WHAT STOOD HERE: an in-turn recap enqueued after the forced compaction
      // (2026-07-23, the owner's .19 transcript, seven near-identical apologies in one
      // long turn), saying "This is still the SAME turn … Do NOT re-introduce yourself".
      //
      // WHY IT IS GONE — MEASURED, NOT ARGUED. W27's census could not tell whether it
      // had ever reached a model and refused to guess (§6.1: "it needs a driven check,
      // not a reading"). The check ran: a real turn across the budget with every
      // messages array recorded, and the recap's bytes appear in NO request on any call
      // (`__tests__/integration.test.ts`, "DRIVEN: the mid-turn recap reaches NO model
      // request"). Both carriers were closed by construction and always were — the
      // queue's only drain is `assemble/steer-checkpoint.ts` and this step exits the
      // turn eleven statements below, while the queue is per-turn state so the
      // continuation starts empty; and the row it also wrote is role='system', which
      // `tailRender` never emits. It was filed to be abandoned.
      //
      // WHERE THE REQUIREMENT LIVES NOW, both asserted in `integration.test.ts`
      // ("THE RE-HOME, half 1/2"): the PERSON's half is the `[System: This turn ran
      // for N minutes …]` row below, unchanged — "pick up where you left off … do not
      // start over" IS the recap's content, on a surface that reaches somebody; the
      // MODEL's half is `sys.compaction-continuity` (`prompt/assembler.ts`), which
      // rides the SYSTEM prompt for 24 h after any compaction and therefore reaches
      // the continuation turn, the one thing this steer could never do; the OPERATOR's
      // half is the log line below, whose number stays `toolResults` for T13 (CUT 3's
      // H1)'s measured reason — one writer, never reset mid-turn.
      //
      // HANDED UP, NOT FIXED HERE: the retired sentence was also FALSE at this site —
      // the turn does not continue, it parks. Rewording rather than retiring is an HL7
      // pre-registered experiment, which this sitting forbids.
      // ════════════════════════════════════════════════════════════════════════════
      logger.info('v2 mid-turn forced compaction done; the turn parks for a continuation', {
        agentId, turnNumber, toolCallsSoFar: state.toolResults.length,
      }, agentId);
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
    queueSelfWake(agentId, 'turn-budget-continuation');
    return requestExit(state, 'turn-time-budget' satisfies PreCallGatesExitReason);
  }
  return proceed(state);
}
