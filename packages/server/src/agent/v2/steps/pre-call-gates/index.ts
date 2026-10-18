// ════════════════════════════════════════
// PHASE-6 T3 — THE `preCallGates` STEP (CUT 3 in the ordinal order, RULING P6-R3(3))
//
// Everything the loop asks BEFORE it spends a model call: is this turn still wanted,
// is the agent thrashing, has the turn outrun its budget, and does the context still
// fit. Relocated verbatim from `agent/v2/loop.ts` (`:2568`–`:3164` at `c1ad4d5`),
// bounds and wording unchanged.
//
// ── WHY THIS TRANCHE WAS CHOSEN, AND THE MEASUREMENT IS THE ARGUMENT ──
// Re-derived at `ff908ae` over every remaining span with the TypeScript binder
// resolving each identifier to its declaration (so the `nudgeText` name-collision
// class cannot be miscounted): this span has **0 escaping declarations** and the ONLY
// crossing local it writes is `state` itself, which the step contract already carries.
// The next cheapest remaining span owes one carrier and reads twice as much. So no
// carrier field was owed under RULING P6-R3(1) and none was invented.
//
// ── WHAT CHANGED IN THE MOVE, AND IT IS ONLY THIS ──
// Seven `break` statements. Inside the driver's `while` body they left the loop; a
// module cannot `break` its caller's loop, so each became `requestExit` with a NAMED
// reason and the driver honours it at the call site. That is the exit-request channel,
// and its rules live where the type does (`../step-outcome.ts`). Nothing else moved:
// every threshold, every steer floor, every log line, both `chat:error` codes, the
// engine-block escape hatch and all the incident notes are the same bytes.
//
// The logger keeps the component name `v2-loop`. It is not decoration — it is what the
// structured log sink records, and a relocation that renames the field its own
// operators grep by has changed behaviour it did not admit to.
//
// ── THE INPUTS, MEASURED RATHER THAN GUESSED ──
// Twelve declarations of `runV2TurnBody` crossed into this span; the twelfth is `state`, which
// arrives as the first parameter. The mutable driver locals this span only READS ride by VALUE
// (nothing can write them while the driver is suspended awaiting this step), and the ones whose
// writer became a module of its own moved to the turn's bag. The context closure reads them once
// per iteration and hands the VALUE down, so nothing here reads a stale copy.
//
// TWO ARE FUNCTIONS THE DRIVER OWNS, passed rather than imported — CUT 2's precedent
// for `stopStatusHeartbeat`, and for the same reason: importing them from `loop.ts`
// would point a step back at the driver. `stashContinuationIfHuman` is additionally a
// CLOSURE over driver state, and a function VALUE keeps the bindings it closed over,
// so passing it preserves live-read semantics by construction.
// ════════════════════════════════════════

import type { WsEvent } from '@dojo/shared';
import { createLogger } from '../../../../logger.js';
import { isStopFenced, preemptedAgents } from '../../../shared-state.js';
import { type AgentTurnState, type TurnPhase } from '../../state.js';
import { latchEngineCut } from '../../engine-exit.js';
import type { TurnCounterparty } from '../../counterparty.js';
import { proceed, requestExit, type StepOutcome } from '../step-outcome.js';
import { runThrashGate } from './thrash-gate.js';
import { runTurnTimeBudget } from './turn-budget.js';
import { runContextGates } from './context-gates.js';

const logger = createLogger('v2-loop');

/** The phase the driver advances into before calling this step. */
export const PRE_CALL_GATES_PHASE: TurnPhase = 'preCallGates';

/**
 * Why this step asked the driver to leave the loop.
 *
 * Four of the `while` body's exits live in this step — it is the loop's first, so it
 * is the only one that can refuse an iteration outright — and every one of them is a
 * guard with an incident behind it. (t137: the seventh, `turn-continuation-cap`, went with
 * the total-time cap — OR-LONG-JOBS.)
 */
export type PreCallGatesExitReason =
  | 'stopped-by-user'
  | 'preempted'
  | 'thrash-auto-block'
  | 'turn-time-budget';

export interface PreCallGatesContext {
  readonly agentId: string;
  readonly turnNumber: number;
  readonly contextWindow: number;
  readonly contextModelId: string;
  readonly configuredModelId: string;
  readonly isAutoRouted: boolean;
  /** Who this turn is for. Read once, by the terminal block's F1 user-origin test. */
  readonly counterparty: TurnCounterparty;
  // HL4 STEP 2 (2d): `engineStartAckDeliveredThisTurn` and `deferredDeliveredByAck` are
  // REMOVED. Their one reader here was the retired `compaction-recap` steer's ack clause
  // (tombstone in `turn-budget.ts`); the bag still carries them for `assemble`/`execute`.
  /**
   * The block's own "tell the user if this looks wrong" sentence. It stays defined in
   * the driver because four of its five readers are in the `execute` tranche; passing
   * it keeps ONE definition rather than a second copy here.
   */
  readonly engineBlockEscapeHatch: string;
  readonly broadcast: (event: WsEvent) => void;
  /** A closure over driver state (C3). Passed as a VALUE, which keeps its bindings. */
  readonly stashContinuationIfHuman: () => void;
  /** The driver's thrash detector, passed rather than imported. See the header. */
  readonly detectTaskThrashing: (agentId: string) => {
    thrashing: boolean;
    toolName?: string;
    signature?: string;
    count?: number;
  };
}

/**
 * The pre-call gates, in the order they have always run.
 *
 * ⚠ THE ORDER IS PART OF THE CONTRACT. A turn that has been stopped must not go on to
 * run the thrash detector or spend a token estimate on a context it will never
 * assemble, and the contract test asserts exactly that rather than trusting the
 * sequence below to stay in this order.
 *
 * `state` is reassigned exactly as it was inside the loop body — every assignment is
 * still a whole-state `advance`, so `validate()` still runs on each one — and the
 * returned outcome carries the last value, including on the way out.
 */
export async function runPreCallGates(
  state: AgentTurnState,
  ctx: PreCallGatesContext,
): Promise<StepOutcome> {
  const { agentId } = ctx;

  // Stop / preempt checks
  //
  // UX-REPAIR T37: this gate READS the stop flag and no longer deletes it. The
  // clear belongs to the run's own exit path (`runtime.ts`'s `finally`), which
  // is the only place that runs after every one of this turn's remaining
  // machinery — including the end-of-run drains that used to restart the agent
  // 500 ms after the user stopped it. The requirement the delete carried ("a
  // stale flag must never kill the NEXT turn") is kept, and kept more exactly:
  // the flag now dies with the run that honoured it.
  // T83 FIX ROUND (review IMPORTANT A-2 + A-3): the FENCE, so a reset-session landing mid-run
  // cannot talk this gate out of a stop; and NO `setAgentStatus(agentId, 'idle')` here. That
  // write told the same lie `stopAgent` stopped telling — the turn has not finalized, the run's
  // `finally` has not run, `activeRuns` still holds the agent, and every busy-guard in the
  // platform reads that row. Teardown writes idle when the run is genuinely down.
  // t93: AND THE RECORD SAYS SO. Both arms below used to leave the turn record deriving its
  // own exit reason from what teardown could see, which is nothing about either event — so an
  // owner pressing stop was written down as `no_reply_intended`, the model's intent, and the
  // ask ladder spent a rung on it. `latchEngineCut` carries the fact to the recorder.
  if (isStopFenced(agentId)) {
    logger.info('v2 agent stopped by user', {}, agentId);
    return requestExit(latchEngineCut(state, 'stop'), 'stopped-by-user' satisfies PreCallGatesExitReason);
  }
  if (preemptedAgents.has(agentId)) {
    preemptedAgents.delete(agentId);
    logger.info('v2 run preempted, queued wakeup will fire', {}, agentId);
    // T83 FIX ROUND (review IMPORTANT A-3): the idle write that stood here is gone — `teardown`
    // is the ONE owner now. See `teardown/index.ts`'s `settleStatus`.
    return requestExit(latchEngineCut(state, 'preempt'), 'preempted' satisfies PreCallGatesExitReason);
  }

  const thrash = runThrashGate(state, ctx);
  if (thrash.directive !== 'proceed') return thrash;

  const budget = await runTurnTimeBudget(thrash.state, ctx);
  if (budget.directive !== 'proceed') return budget;

  const context = await runContextGates(budget.state, ctx);
  if (context.directive !== 'proceed') return context;

  return proceed(context.state);
}
