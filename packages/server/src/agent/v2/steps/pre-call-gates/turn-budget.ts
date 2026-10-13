// ════════════════════════════════════════
// PHASE-6 T3 — preCallGates, part 2 of 3: THE TURN-TIME BUDGET.
//
// Relocated verbatim from `agent/v2/loop.ts` (`:2912`–`:3013` at `c1ad4d5`).
//
// The turn does not HALT at 15 minutes — it checkpoints: ASK whether the context needs
// compacting, square the tracker, and queue a wakeup so the work resumes on a fresh turn.
// T84 (2026-09-21) retired the `force` on that ask; read its block at the call site —
// incident, guard history and re-homed requirement — before putting the flag back.
//
// t137 (v3.3.3, OR-LONG-JOBS) — THE CHECKPOINT IS INVISIBLE HOUSEKEEPING AND THERE IS NO
// TOTAL-TIME CAP. The owner's words: "I want agents to be able to continue working long jobs…
// as long as they need… we can't have the dojo panic every 15 minutes because an agent isn't
// responding." Two things that stood here are GONE, not reworded:
//   1. the per-park "[System: This turn ran for N minutes. Pausing here … (k of cap)]" row and
//      its chat broadcast. It was role='system', which the tail renderer never emits, so the
//      MODEL never read it; the only reader was the owner, every fifteen minutes (tracker #10).
//      requirement preserved: the model's half of "pick up where you left off" is the task list
//      (t139) — v3.3.3 condenses only rows already leaving view (t140), so nothing it reads moves;
//      the operator's half is the log line below; the tracker's half is `noteEngineCheckpoint`.
//   2. the continuation cap (`MAX_TURN_AUTO_CONTINUATIONS`, later a per-provider budget whose
//      column migration 186 drops), its "running for about N minutes … Pausing here" row
//      and its PM hand-off. A long job now parks and continues for as long as it needs.
//      requirement preserved: the money guardrail is the budget alerts (t138); a genuinely stuck
//      job is the liveness lane's (t143: BROKEN / SILENT / SPINNING) and the thrash gate's.
//      This step never decides that elapsed time alone means trouble.
//
// HL4 STEP 2 (2d), 2026-08-15: there used to be an in-turn `compaction-recap` STEER here
// too. It is RETIRED, with the driven measurement and the homes its requirement moved to
// written out at the tombstone below. Read that before adding anything back.
// ════════════════════════════════════════

import { createLogger } from '../../../../logger.js';
import { getContextWindow } from '../../../model.js';
import { checkAndCompact } from '../../../../memory/compaction.js';
import { turnContinuationCounts, queueSelfWake, isStopFenced } from '../../../shared-state.js';
import { type AgentTurnState } from '../../state.js';
import { proceed, requestExit, type StepOutcome } from '../step-outcome.js';
import { latchEngineCut } from '../../engine-exit.js';
import { noteEngineCheckpoint, deliverPendingCirclingVerdict } from '../../../../work/engine-checkpoint-note.js';
import type { PreCallGatesContext, PreCallGatesExitReason } from './index.js';

const logger = createLogger('v2-loop');

const TURN_TIME_BUDGET_MS = 15 * 60 * 1000;    // matches v1, 15 min/turn

/**
 * The turn-time budget checkpoint. Returns `proceed` while the turn is inside its
 * budget; otherwise the turn parks for a continuation (or, if the owner pressed Stop during
 * the checkpoint, ends on the stop).
 */
export async function runTurnTimeBudget(
  state: AgentTurnState,
  ctx: PreCallGatesContext,
): Promise<StepOutcome> {
  const {
    agentId, turnNumber, configuredModelId, stashContinuationIfHuman,
  } = ctx;

  // ── F10 note: the start-ack floor is the wall-clock timer armed at turn
  // start (search "F10: wall-clock start-ack timer"), NOT a loop-boundary
  // check here. A boundary check could only fire between model rounds, and
  // a single slow first round pushed the ack to seconds before the reply
  // (observed live), while wakeup/drain turns with a user counterparty but
  // no waiting human got a stray "On it." attached to nothing. ──

  // ── Turn time budget, auto-continue, don't halt ──
  // (Matches v1 runtime.ts:884-919.) When a turn runs longer than 15 min, check whether the
  // context wants compacting and queue a wakeup so the agent picks up where it left off — as
  // many times as the job needs (t137: no cap; see the header). The counter only numbers the
  // parks for the operator's log; nothing decides on it.
  if (Date.now() - state.turnStartMs > TURN_TIME_BUDGET_MS) {
    const elapsedMin = Math.round((Date.now() - state.turnStartMs) / 60000);
    const continuationCount = (turnContinuationCounts.get(agentId) ?? 0) + 1;
    // The `__auto__` resolution the compaction ask has always used: `__auto__` names no model
    // of its own to read a context window off.
    const effectiveModel =
      state.modelId === '__auto__' ? configuredModelId : state.modelId;

    turnContinuationCounts.set(agentId, continuationCount);
    logger.warn('v2 turn time budget reached, auto-continuing', {
      elapsedMin, continuationCount, agentId,
    }, agentId);

    // ── T84 — NO `{ force: true }` HERE. THE TOKEN MATH DECIDES. ──
    //
    // `force` bypasses `runCheckAndCompact`'s ENTIRE trigger and all three yield guards, so
    // this line used to make elapsed wall-clock ALONE a reason to rebuild an agent's history.
    // On 2026-09-21 the elapsed time was honest provider re-prefill and it compacted 13,649
    // assembled against a 51,300 threshold — 27% fill, `needsCompactionByTokens: false` in the
    // log line it emitted — severing a live agent from a half-served two-part ask.
    //
    // THE FLAG'S HISTORY, walked before it was weakened (owner ruling 10(c)): born at
    // `34c75dc6` (v1.15.80, 2026-04-29) carrying ONE inference — "the long-running turn has
    // bloated context; without this, the resumed turn inherits the same heavy context and
    // times out again immediately" — with no incident attached, and never re-encoded since
    // (`716a8bc9`, `74319d0a` are verbatim carries). That requirement now rides the mechanisms
    // that can measure it: heavy context IS `needsCompactionByTokens`, provider-aware since
    // T82a (a slow box compacts EARLIER than the old flat 96%); long accumulation is
    // `needsCompactionByGap`; bloat inside the fresh tail is the case compaction cannot fix at
    // all; a stuck agent is the thrash gate's and the liveness lane's (t137 retired the cap).
    //
    // Full record: census row 25 (NO-DOOMED-DIALS), and
    // `__tests__/the-clock-does-not-overrule-the-token-math.test.ts`, which drives this
    // checkpoint against a real database on the incident's own numbers. The auto-continue
    // below is untouched.
    let historyWasRebuilt = false;
    try {
      const compaction = await checkAndCompact(agentId, effectiveModel, getContextWindow(effectiveModel));
      historyWasRebuilt = compaction.leafCreated > 0 || compaction.condensedCreated > 0;
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
      // WHERE THE REQUIREMENT LIVES NOW: the PERSON's half was the `[System: This turn
      // ran for N minutes …]` row — retired by t137 (OR-LONG-JOBS: a park is invisible
      // housekeeping, and that row never reached the model either); the
      // MODEL's half is the task list (t139), which reaches the continuation turn —
      // the one thing this steer could never do — and v3.3.3 condenses only rows already
      // leaving view (t140; the 24 h `sys.compaction-continuity` section went); the OPERATOR's
      // half is the log line below, whose number stays `toolResults` for T13 (CUT 3's
      // H1)'s measured reason — one writer, never reset mid-turn.
      //
      // HANDED UP, NOT FIXED HERE: the retired sentence was also FALSE at this site —
      // the turn does not continue, it parks. Rewording rather than retiring is an HL7
      // pre-registered experiment, which this sitting forbids.
      // ════════════════════════════════════════════════════════════════════════════
      // T84: the number stays `toolResults` for T13 (CUT 3's H1)'s measured reason, named in
      // the tombstone above. `historyWasRebuilt` is the operator's half of this fix — a
      // checkpoint that compacted and one that (correctly) did not must be told apart.
      logger.info('v2 turn-budget checkpoint: the turn parks for a continuation', {
        agentId, turnNumber, toolCallsSoFar: state.toolResults.length, historyWasRebuilt,
      }, agentId);
    } catch (compErr) {
      logger.warn('v2 compaction check at turn-budget checkpoint failed', {
        agentId, error: compErr instanceof Error ? compErr.message : String(compErr),
      }, agentId);
    }

    // ── T83 — A STOP THAT LANDED DURING THE CHECKPOINT'S COMPACTION ENDS THE TURN HERE ──
    //
    // (T84: nothing in this guard depended on the compaction being FORCED — one the token
    // math DOES want dials the same summariser for the same minutes, and a checkpoint that
    // compacts nothing merely reaches this re-read sooner.)
    //
    // This checkpoint is the longest un-gated stretch in a turn: the gate that reads the stop
    // flag runs ABOVE this step, and the compaction above it dials a summariser that
    // took 285 seconds on the measured run (dev box, 2026-09-21, 04:22:25 → 04:27:10). The
    // stop landed at 04:22:42, seventeen seconds in — and the checkpoint went on to write
    // "Pausing here and continuing on a fresh turn (3 of 31)" into the owner's chat and queue
    // the continuation that resumed the plan they had stopped.
    //
    // Aborting the compaction call (which now happens) is necessary and not sufficient: the
    // abort surfaces as a caught `compErr` above and execution simply continues into the park.
    // `queueSelfWake` would refuse the wakeup, but the tracker would still be noted (and, before
    // t137, a park message written) — an engine announcing a continuation that is never coming. So
    // the checkpoint re-reads the stop at the one moment it can have changed, and exits on the
    // stop's own reason: nothing parked, nothing queued, nothing claimed.
    if (isStopFenced(agentId)) {
      logger.info('v2 turn-budget checkpoint: the user stopped this agent during the compaction check; not parking and not queuing a continuation', {
        agentId, turnNumber, continuationCount,
      }, agentId);
      turnContinuationCounts.delete(agentId);
      // t93: the OWNER's word, not the budget's — this arm exists because the stop landed INSIDE
      // the compaction check, so `stop` is both the most recent cause and the only one a person
      // took. `latchEngineCut` is first-writer-wins, so a stop that was already recorded upstream
      // stays recorded and this is a no-op.
      return requestExit(latchEngineCut(state, 'stop'), 'stopped-by-user' satisfies PreCallGatesExitReason);
    }

    // t137: NO PARK ROW AND NO BROADCAST HERE. A pending PM circling verdict goes to the AGENT
    // as a rider notice its continuation reads (`deliverPendingCirclingVerdict`); it used to ride
    // the park row, which only the owner ever saw.
    deliverPendingCirclingVerdict(agentId);   // never throws; a failure leaves it pending for the sweep
    //
    // T79a: this checkpoint is about to park the turn with whatever the agent had claimed
    // still in flight. Square the tracker BEFORE queuing the continuation, so the very next
    // turn's close-out gate (`preflight/closeout-gate.ts`) does not read "checkpointed" as
    // "abandoned" and refuse the continuation's own tool calls.
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
    // t93: `budget` HERE TOO, and the reason is the `iteration_cap` reason exactly. This arm is an
    // ENGINE CUT with a continuation queued behind it — the turn is stopped mid-work at the
    // 15-minute checkpoint and told to resume on a fresh one — and it recorded
    // `no_reply_intended` on every one of those, so a long task spent the owner's re-serve ladder
    // one checkpoint at a time. `turns.answered` still says, separately, whether anything was
    // delivered.
    return requestExit(latchEngineCut(state, 'budget'), 'turn-time-budget' satisfies PreCallGatesExitReason);
  }
  return proceed(state);
}
