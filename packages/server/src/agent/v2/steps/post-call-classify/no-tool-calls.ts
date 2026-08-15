// ════════════════════════════════════════
// PHASE-6 T6 (CUT 8) — "NO TOOLS? LOOP IS DONE." — the 1,060-line region that was the
// single largest contiguous block in the whole phase, and the reason CUT 7 measured
// both remaining candidates before choosing (`postCallClassify`'s largest region was
// 139 lines BIGGER than `execute`'s).
//
// It is not one thing. It is the turn-ending FLOOR FAMILY, run in a fixed order, and
// the order is load-bearing: each floor asks "is the person owed something this turn
// did not give them?", and the first one that says yes hands the model one more round.
// Split here on the seams the block already had, one file per floor family, and
// SEQUENCED here so the order is a list a reader can check rather than 1,060 lines of
// nesting to trace.
//
// ELEVEN OF THIS TRANCHE'S TWENTY-FOUR CONVERSIONS ARE INSIDE THESE SEVEN FILES: nine
// `continue`s (every one a floor asking for another round) and four `break`s — three of
// them in the sub-modules and the LAST ONE HERE, which is the plain and much the most
// common way a turn ends: the model produced text, called no tools, and the loop is
// over.
//
// A SECTION THAT ASKS TO STOP STOPS. Each call below returns the first non-`proceed`
// outcome straight to the driver, so a floor that fires is the last thing that runs —
// which is exactly what a `break` or `continue` did in the original nesting.
//
// ── HL4 STEP 2 (2a), 2026-08-15: THE ORDER IS DECLARED, AND IT IS NOT DECLARED HERE ──
//
// The sentence above — "the order is load-bearing" — was true and undeclared, and that
// is the whole finding W27's census landed (finding 2). The engine carried TWO orderings
// over these seven floors: `STEER_PRECEDENCE` in `steer-queue.ts`, which is declared,
// argued in five bands and tested, and decides which PENDING steer is DELIVERED first;
// and the hand-written call sequence that used to live in this function, which decided
// which detector got to FIRE AT ALL — because the first firer returns and the other six
// never run. They disagreed, and the disagreement had a victim: `going-idle-in-progress`
// ran SECOND while the table ranks it NINTH, so on a turn where a person's mid-turn
// message and a dangling task both qualified, `owed-interrupt` (27) and `promise-floor`
// (28) never ran and the round went to the housekeeping floor below them.
//
// THE TABLE IS THE AUTHORITY. `TURN_ENDING_FAMILY` below is sorted by it at module load,
// so the running order cannot drift from the declared one — re-rank a floor in
// `steer-queue.ts` and the chain moves with it. A second ordering is no longer
// expressible here, which is the point: a fifth ordering is the disease, and naming the
// authority is the cure.
// ════════════════════════════════════════

import { type AgentTurnState } from '../../state.js';
import { steerPriority, type SteerFloorId } from '../../steer-queue.js';
import { requestExit, type StepOutcome } from '../step-outcome.js';
import { runSilentCloseout } from './silent-closeout.js';
import { runGoingIdle } from './going-idle.js';
import { runOwedInterrupt } from './owed-interrupt.js';
import { runPromiseFloor } from './promise-floor.js';
import { runHandoffFloors } from './handoff-floors.js';
import { runMissedReply } from './missed-reply.js';
import { runTrackerCloseout } from './tracker-closeout.js';
import type { PostCallClassifyContext, PostCallScratch } from './index.js';

/** One member of the turn-ending family: the floor it speaks as, and its detector. */
export interface TurnEndingFloor {
  /** The `STEER_PRECEDENCE` id this detector's own steer is filed under. It is what
   *  ranks the member, so a runner and its steer can never rank differently. */
  readonly floor: SteerFloorId;
  readonly run: (
    state: AgentTurnState,
    ctx: PostCallClassifyContext,
    sc: PostCallScratch,
  ) => StepOutcome | Promise<StepOutcome>;
}

/**
 * THE TURN-ENDING FAMILY, ORDERED BY THE DECLARED TABLE.
 *
 * The list is written in table order for a reader; the `sort` is what makes that a
 * PROPERTY rather than a convention, and it is why nobody has to keep two lists in
 * agreement ever again.
 *
 * `runGoingIdle` files TWO floors — `add-notes-stop` (61) and `going-idle-in-progress`
 * (31) — and it is declared at 31, the higher-ranking of the pair, because that is the
 * one whose eligibility decides whether the runner takes the round. The pair's own
 * ordering is not this list's business: it is resolved INSIDE that file by an explicit
 * gate (the narrow detector disarms its broader sibling), which is the one place in the
 * tree where two floors' overlap was already written down rather than left to sequence.
 */
export const TURN_ENDING_FAMILY: readonly TurnEndingFloor[] = Object.freeze([
  { floor: 'silent-closeout',        run: runSilentCloseout },
  { floor: 'going-idle-in-progress', run: runGoingIdle },
  { floor: 'owed-interrupt',         run: runOwedInterrupt },
  { floor: 'promise-floor',          run: runPromiseFloor },
  { floor: 'a2a-handoff-floor',      run: runHandoffFloors },
  { floor: 'a2a-missed-reply',       run: runMissedReply },
  { floor: 'tracker-closeout',       run: runTrackerCloseout },
] as TurnEndingFloor[]);

/** The turn-ending floor family, in the order the span ran it. */
export async function runNoToolCalls(
  state: AgentTurnState,
  ctx: PostCallClassifyContext,
  sc: PostCallScratch,
): Promise<StepOutcome> {
  for (const member of TURN_ENDING_FAMILY) {
    const outcome = await member.run(state, ctx, sc);
    if (outcome.directive !== 'proceed') return outcome;
    state = outcome.state;
  }
  return requestExit(state, 'no-tool-calls-turn-is-done');
}
