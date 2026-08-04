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
// ════════════════════════════════════════

import { type AgentTurnState } from '../../state.js';
import { requestExit, type StepOutcome } from '../step-outcome.js';
import { runSilentCloseout } from './silent-closeout.js';
import { runGoingIdle } from './going-idle.js';
import { runOwedInterrupt } from './owed-interrupt.js';
import { runPromiseFloor } from './promise-floor.js';
import { runHandoffFloors } from './handoff-floors.js';
import { runMissedReply } from './missed-reply.js';
import { runTrackerCloseout } from './tracker-closeout.js';
import type { PostCallClassifyContext, PostCallScratch } from './index.js';

/** The turn-ending floor family, in the order the span ran it. */
export async function runNoToolCalls(
  state: AgentTurnState,
  ctx: PostCallClassifyContext,
  sc: PostCallScratch,
): Promise<StepOutcome> {
  const silent = await runSilentCloseout(state, ctx, sc);
  if (silent.directive !== 'proceed') return silent;
  state = silent.state;

  const idle = await runGoingIdle(state, ctx, sc);
  if (idle.directive !== 'proceed') return idle;
  state = idle.state;

  const owed = await runOwedInterrupt(state, ctx, sc);
  if (owed.directive !== 'proceed') return owed;
  state = owed.state;

  const promise = runPromiseFloor(state, ctx, sc);
  if (promise.directive !== 'proceed') return promise;
  state = promise.state;

  const handoff = await runHandoffFloors(state, ctx, sc);
  if (handoff.directive !== 'proceed') return handoff;
  state = handoff.state;

  const missed = runMissedReply(state, ctx, sc);
  if (missed.directive !== 'proceed') return missed;
  state = missed.state;

  const closeout = await runTrackerCloseout(state, ctx, sc);
  if (closeout.directive !== 'proceed') return closeout;
  state = closeout.state;

  return requestExit(state, 'no-tool-calls-turn-is-done');
}
