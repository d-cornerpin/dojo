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
import { getDb } from '../../../../db/connection.js';
import { checkAndCompact } from '../../../../memory/compaction.js';
import { insertMessageIfAbsent } from '../../../../memory/message-store.js';
import { turnContinuationCounts, queueSelfWake, isStopFenced } from '../../../shared-state.js';
import { type AgentTurnState } from '../../state.js';
import { proceed, requestExit, type StepOutcome } from '../step-outcome.js';
import { noteEngineCheckpoint, pendingCirclingVerdictParkLine } from '../../../../work/engine-checkpoint-note.js';
import { resolveUnattendedBudget, continuationCapFor } from '../../../unattended-budget.js';
import type { PreCallGatesContext, PreCallGatesExitReason } from './index.js';

const logger = createLogger('v2-loop');

const TURN_TIME_BUDGET_MS = 15 * 60 * 1000;    // matches v1, 15 min/turn
const TURN_TIME_BUDGET_MIN = TURN_TIME_BUDGET_MS / 60000;

// SLOW-INFERENCE T79b: `MAX_TURN_AUTO_CONTINUATIONS = 3` USED TO LIVE HERE, HARD-CODED. It
// is gone, not renamed — the continuation cap is now DERIVED per turn, from whatever provider
// is actually serving the model this turn, via `readProviderUnattendedBudgetMinutes` below and
// `agent/unattended-budget.ts`'s `resolveUnattendedBudget` / `continuationCapFor`. An
// undeclared provider (every provider configured before this task, and every preset since)
// still resolves to a cap of exactly 3 — `continuationCapFor(60, 15) === 3` — so this is a
// widening, not a behavior change, for everyone who has not opened the new door.
//
// WHY THE READ IS FRESH, HERE, EVERY TIME. Migration 164's census names this the column's one
// reader. `getModelInfo` (`agent/model.ts:547`) already performs the identical
// `models JOIN providers` join for response patience (163) and could have carried this column
// too — deliberately not done: `getModelInfo` is private, has a dozen call sites, and none of
// them are this one. Mirroring its query here, scoped to the single column this gate needs,
// keeps `agent/unattended-budget.ts` a pure leaf (like `stream-patience.ts`) and keeps this
// the ONLY place in the tree that reads `providers.max_unattended_minutes`.
//
// Never throws: a cap check is not the place to discover a missing table or a broken
// connection, and `resolveUnattendedBudget(null)` already means "the standing default" — the
// same answer a genuinely NULL row would give.
function readProviderUnattendedBudgetMinutes(modelId: string): number | null {
  try {
    const db = getDb();
    const row = db.prepare(`
      SELECT p.max_unattended_minutes AS max_unattended_minutes
      FROM models m
      JOIN providers p ON p.id = m.provider_id
      WHERE m.id = ?
    `).get(modelId) as { max_unattended_minutes: number | null } | undefined;
    return row?.max_unattended_minutes ?? null;
  } catch {
    return null;
  }
}

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
  // left off. SLOW-INFERENCE T79b: how many consecutive checkpoints we allow
  // before giving up is no longer a flat 3 — it is derived from the serving
  // provider's own declared unattended budget (see `continuationCapFor`
  // above), floored at exactly 3 for a provider that has declared nothing.
  if (Date.now() - state.turnStartMs > TURN_TIME_BUDGET_MS) {
    const elapsedMin = Math.round((Date.now() - state.turnStartMs) / 60000);
    const continuationCount = (turnContinuationCounts.get(agentId) ?? 0) + 1;

    // Computed BEFORE the cap decision, not inside the (former) continue-only branch: the
    // decision itself now depends on it. Resolved via the agent's EFFECTIVE model — same
    // `__auto__` resolution the forced compaction below has always used — because `__auto__`
    // names no provider of its own to read a budget off.
    const effectiveModel =
      state.modelId === '__auto__' ? configuredModelId : state.modelId;
    const declaredMinutes = readProviderUnattendedBudgetMinutes(effectiveModel);
    const budgetMinutes = resolveUnattendedBudget(declaredMinutes);
    const cap = continuationCapFor(budgetMinutes, TURN_TIME_BUDGET_MIN);

    if (continuationCount > cap) {
      turnContinuationCounts.delete(agentId);
      logger.error('v2 turn auto-continuation cap reached, stopping', {
        elapsedMin, continuationCount, cap, budgetMinutes, declaredMinutes, agentId,
      }, agentId);
      // SLOW-INFERENCE T79b: honest pause, not a guess. The old sentence ("usually means a
      // stuck loop, an over-scoped task, or a slow model") was a diagnosis the engine has no
      // evidence for — every one of those three reads identically at this checkpoint, which is
      // exactly why it was a guess. What the engine DOES know is the number it just spent: the
      // provider's own declared budget (or the standing default, named as such), and that the
      // PM — not the owner noticing silence — has just been handed the resumption below.
      const totalMin = (cap + 1) * TURN_TIME_BUDGET_MIN;
      const budgetLabel = declaredMinutes === null
        ? 'the standard 60-minute unattended budget (no budget declared for this provider)'
        : `this provider's declared ${budgetMinutes}-minute unattended budget`;
      const stuckMsg = (
        `[System: This task has been running for about ${totalMin} minutes without finishing, ` +
        `reaching ${budgetLabel}. Pausing here — the project manager has been handed the resumption ` +
        `and will decide the next step, so this is not being left silent. Send a follow-up yourself to ` +
        `resume it sooner, or break the work into smaller pieces.]`
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
      // T79a: square the tracker on THIS trip too — the checkpoint note's union always
      // included 'unattended-budget' for exactly this call site (see its header). The turn is
      // ending, not continuing, but whatever this agent had claimed is still genuinely
      // in-flight the instant before this trip, and the next turn anyone (the PM, a follow-up
      // from the owner) triggers must not read a fresh pause as a stale abandonment.
      try {
        noteEngineCheckpoint(agentId, 'unattended-budget');
      } catch (checkpointErr) {
        logger.warn('v2: engine-checkpoint tracker note failed at unattended-budget trip (non-fatal)', {
          agentId, error: checkpointErr instanceof Error ? checkpointErr.message : String(checkpointErr),
        }, agentId);
      }
      // T79b: the PM hand-off. This is what turns "silent death" into "honest pause" — nothing
      // upstream of this call queues a self-wake for a tripped turn (a cap is a cap), so
      // without this the agent would simply go quiet until somebody happened to look. Best
      // effort and non-fatal by the same convention as the checkpoint note just above: a PM
      // that is offline, unconfigured, or unreachable does not make the trip un-happen, and the
      // owner can still see it from the dashboard.
      try {
        const { escalateUnattendedBudgetTripToPM } = await import('../../../../tracker/pm-agent.js');
        await escalateUnattendedBudgetTripToPM({
          agentId,
          budgetMinutes,
          continuationCap: cap,
          elapsedMinutes: totalMin,
          declaredByProvider: declaredMinutes !== null,
        });
      } catch (pmErr) {
        logger.warn('v2: PM hand-off failed at unattended-budget trip (non-fatal)', {
          agentId, error: pmErr instanceof Error ? pmErr.message : String(pmErr),
        }, agentId);
      }
      return requestExit(state, 'turn-continuation-cap' satisfies PreCallGatesExitReason);
    }

    turnContinuationCounts.set(agentId, continuationCount);
    logger.warn('v2 turn time budget reached, auto-continuing with forced compaction', {
      elapsedMin, continuationCount, cap, agentId,
    }, agentId);

    // Force compaction so next turn starts with summarized history.
    try {
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

    // ── T83 — A STOP THAT LANDED DURING THE FORCED COMPACTION ENDS THE TURN HERE ──
    //
    // This checkpoint is the longest un-gated stretch in a turn: the gate that reads the stop
    // flag runs ABOVE this step, and the forced compaction below it dials a summariser that
    // took 285 seconds on the measured run (dev box, 2026-09-21, 04:22:25 → 04:27:10). The
    // stop landed at 04:22:42, seventeen seconds in — and the checkpoint went on to write
    // "Pausing here and continuing on a fresh turn (3 of 31)" into the owner's chat and queue
    // the continuation that resumed the plan they had stopped.
    //
    // Aborting the compaction call (which now happens) is necessary and not sufficient: the
    // abort surfaces as a caught `compErr` above and execution simply continues into the park.
    // `queueSelfWake` would refuse the wakeup, but the park MESSAGE would still be written and
    // the tracker still noted — an engine announcing a continuation that is never coming. So
    // the checkpoint re-reads the stop at the one moment it can have changed, and exits on the
    // stop's own reason: nothing parked, nothing queued, nothing claimed.
    if (isStopFenced(agentId)) {
      logger.info('v2 turn-budget checkpoint: the user stopped this agent during the forced compaction; not parking and not queuing a continuation', {
        agentId, turnNumber, continuationCount,
      }, agentId);
      turnContinuationCounts.delete(agentId);
      return requestExit(state, 'stopped-by-user' satisfies PreCallGatesExitReason);
    }

    // T79 FIX WAVE, FINDING 2: read BEFORE the park message is built, so an undelivered
    // circling verdict for whatever this agent has claimed rides the SAME tail-side system row
    // as an honest additional line — the one surface a never-idle agent is guaranteed to read
    // on its very next turn. `null` (no pending verdict, the common case) leaves `sysMsg`
    // byte-identical to before this fix.
    const circlingLine = pendingCirclingVerdictParkLine(agentId);
    const sysMsg = (
      `[System: This turn ran for ${elapsedMin} minutes. Pausing here and continuing on a fresh turn ` +
      `(${continuationCount} of ${cap}). ` +
      `Your earlier conversation has been summarized, pick up where you left off. ` +
      `Check work_update(action="list") for the task you were working on; do not start over.]`
    ) + (circlingLine ? `\n\n${circlingLine}` : '');
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
    // T79a: this checkpoint is about to park the turn with whatever the agent had claimed
    // still in flight. Square the tracker BEFORE queuing the continuation, so the very next
    // turn's close-out gate (`preflight/closeout-gate.ts`) does not read "checkpointed" as
    // "abandoned" and refuse the continuation's own tool calls. T79b answers the cap/trip
    // branch above the same way — see its own `noteEngineCheckpoint('unattended-budget')`
    // call — because a trip is a stop, not a continuation, but the in-flight work it stops was
    // no less real the instant before the stop.
    try {
      noteEngineCheckpoint(agentId, 'turn-budget');
    } catch (checkpointErr) {
      logger.warn('v2: engine-checkpoint tracker note failed (non-fatal)', {
        agentId, error: checkpointErr instanceof Error ? checkpointErr.message : String(checkpointErr),
      }, agentId);
    }
    // Queue wakeup so handleMessage's finally fires the loop again
    stashContinuationIfHuman(); // C3: carry the human conversation into the continuation
    queueSelfWake(agentId, 'turn-budget-continuation');
    return requestExit(state, 'turn-time-budget' satisfies PreCallGatesExitReason);
  }
  return proceed(state);
}
