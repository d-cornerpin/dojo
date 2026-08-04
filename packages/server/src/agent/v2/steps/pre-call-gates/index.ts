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
// Twelve declarations of `runV2TurnBody` cross into this span. Eleven are below;
// the twelfth is `state`, which arrives as the first parameter.
//
// THREE OF THEM ARE MUTABLE DRIVER LOCALS THAT THIS SPAN ONLY READS, and they ride
// by VALUE rather than migrating to the turn's bag. That is a decision with positive
// evidence behind it, not an omission: `assemblerOverheadTokens`,
// `engineStartAckDeliveredThisTurn` and `deferredDeliveredByAck` have exactly one
// write site each (`loop.ts:3273`, `:4648`, `:4652`), all three in the straight-line
// body of `runV2TurnBody` and NONE inside a timer or callback — so nothing can write
// them while the driver is suspended awaiting this step, and a value read at the call
// site is the same value the lexical block would have read. The tranches that WRITE
// them (`assemble`, `postCallClassify`) are the ones that will owe the migration.
//
// ⚠ BOTH TRANCHES HAVE NOW PAID, AND THIS STEP'S SIDE OF IT DID NOT CHANGE.
// `assemblerOverheadTokens` moved to the bag at CUT 6 and the ack-delivery pair at CUT 8,
// each because the span that WRITES it became a module and a module cannot write a caller's
// local. The reading half above still stands and is still the reason this interface keeps
// three plain booleans/numbers: the driver's context closure reads them off the bag once per
// iteration and hands the VALUE down, which is what the "nothing can write them while this
// step is awaited" evidence licenses. Nothing here reads a stale copy, because nothing here
// outlives the iteration that built it.
//
// TWO ARE FUNCTIONS THE DRIVER OWNS, passed rather than imported — CUT 2's precedent
// for `stopStatusHeartbeat`, and for the same reason: importing them from `loop.ts`
// would point a step back at the driver. `stashContinuationIfHuman` is additionally a
// CLOSURE over driver state, and a function VALUE keeps the bindings it closed over,
// so passing it preserves live-read semantics by construction.
// ════════════════════════════════════════

import type { AgentStatus, WsEvent } from '@dojo/shared';
import { createLogger } from '../../../../logger.js';
import { stoppedAgents, preemptedAgents } from '../../../shared-state.js';
import { type AgentTurnState, type TurnPhase } from '../../state.js';
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
 * Seven of the `while` body's exits live in this step — it is the loop's first, so it
 * is the only one that can refuse an iteration outright — and every one of them is a
 * guard with an incident behind it.
 */
export type PreCallGatesExitReason =
  | 'stopped-by-user'
  | 'preempted'
  | 'thrash-auto-block'
  | 'turn-continuation-cap'
  | 'turn-time-budget'
  | 'context-emergency-compact'
  | 'context-full';

export interface PreCallGatesContext {
  readonly agentId: string;
  readonly turnNumber: number;
  readonly contextWindow: number;
  readonly contextModelId: string;
  readonly configuredModelId: string;
  readonly isAutoRouted: boolean;
  /** Who this turn is for. Read once, by the terminal block's F1 user-origin test. */
  readonly counterparty: TurnCounterparty;
  /**
   * The non-compressible overhead the LAST assemble produced, which the compaction
   * gate subtracts from the window (FA-M1). A mutable driver local this span only
   * reads; see the header for why it rides by value.
   */
  readonly assemblerOverheadTokens: number;
  /** Mutable driver local, read once by the mid-turn recap. See the header. */
  readonly engineStartAckDeliveredThisTurn: boolean;
  /** Mutable driver local, read once by the mid-turn recap. See the header. */
  readonly deferredDeliveredByAck: boolean;
  /**
   * The block's own "tell the user if this looks wrong" sentence. It stays defined in
   * the driver because four of its five readers are in the `execute` tranche; passing
   * it keeps ONE definition rather than a second copy here.
   */
  readonly engineBlockEscapeHatch: string;
  readonly broadcast: (event: WsEvent) => void;
  /** The driver's own status writer, passed rather than imported. See the header. */
  readonly setAgentStatus: (agentId: string, status: AgentStatus) => void;
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
  const { agentId, setAgentStatus } = ctx;

  // Stop / preempt checks
  if (stoppedAgents.has(agentId)) {
    stoppedAgents.delete(agentId);
    logger.info('v2 agent stopped by user', {}, agentId);
    setAgentStatus(agentId, 'idle');
    return requestExit(state, 'stopped-by-user' satisfies PreCallGatesExitReason);
  }
  if (preemptedAgents.has(agentId)) {
    preemptedAgents.delete(agentId);
    logger.info('v2 run preempted, queued wakeup will fire', {}, agentId);
    setAgentStatus(agentId, 'idle');
    return requestExit(state, 'preempted' satisfies PreCallGatesExitReason);
  }

  const thrash = runThrashGate(state, ctx);
  if (thrash.directive !== 'proceed') return thrash;

  const budget = await runTurnTimeBudget(thrash.state, ctx);
  if (budget.directive !== 'proceed') return budget;

  const context = await runContextGates(budget.state, ctx);
  if (context.directive !== 'proceed') return context;

  return proceed(context.state);
}
