// The turn-ending floor family, run when the model called no tools: each floor asks whether the person
// is owed something this turn did not give them, and the first that fires ends this step.

import { type AgentTurnState } from '../../state.js';
import { steerPriority, type SteerFloorId } from '../../steer-queue.js';
import { requestExit, type StepOutcome } from '../step-outcome.js';
import { runGoingIdle } from './going-idle.js';
import { runOwedInterrupt } from './owed-interrupt.js';
import { runPromiseFloor } from './promise-floor.js';
import { runMissedReply } from './missed-reply.js';
import type { PostCallClassifyContext, PostCallScratch } from './index.js';

export interface TurnEndingFloor {
  /** The steer floor this detector files under; it ranks the member, so runner and steer never differ. */
  readonly floor: SteerFloorId;
  readonly run: (
    state: AgentTurnState,
    ctx: PostCallClassifyContext,
    sc: PostCallScratch,
  ) => StepOutcome | Promise<StepOutcome>;
}

/** Sorted by `steerPriority` (`steer-queue.ts`) at load, so the run order cannot drift from the declared
 *  table. `runGoingIdle` files two floors and is ranked by the higher; that file orders the pair itself. */
export const TURN_ENDING_FAMILY: readonly TurnEndingFloor[] = Object.freeze(([
  { floor: 'owed-interrupt',         run: runOwedInterrupt },
  { floor: 'promise-floor',          run: runPromiseFloor },
  { floor: 'a2a-missed-reply',       run: runMissedReply },
  { floor: 'going-idle-in-progress', run: runGoingIdle },
] as TurnEndingFloor[]).sort((a, b) => steerPriority(a.floor) - steerPriority(b.floor)));

/** The turn-ending floor family, in the order the DECLARED TABLE ranks it. */
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
