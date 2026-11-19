// The preCallGates step: the checks before a model call, in order (stop/preempt, time budget, context
// condense). Driver-owned functions arrive through the context, so no step imports `loop.ts`.
// The logger keeps the component name `v2-loop`: operators grep the structured log by it.

import type { WsEvent } from '@dojo/shared';
import { createLogger } from '../../../../logger.js';
import { isStopFenced, preemptedAgents } from '../../../shared-state.js';
import { type AgentTurnState, type TurnPhase } from '../../state.js';
import { latchEngineCut } from '../../engine-exit.js';
import type { TurnCounterparty } from '../../counterparty.js';
import { proceed, requestExit, type StepOutcome } from '../step-outcome.js';
import { runTurnTimeBudget } from './turn-budget.js';
import { runContextGates } from './context-gates.js';

const logger = createLogger('v2-loop');

/** The phase the driver advances into before calling this step. */
export const PRE_CALL_GATES_PHASE: TurnPhase = 'preCallGates';

/** Why this step asked the driver to leave the loop (it runs first, so it can refuse an iteration). */
export type PreCallGatesExitReason =
  | 'stopped-by-user'
  | 'preempted'
  | 'turn-time-budget';

export interface PreCallGatesContext {
  readonly agentId: string;
  readonly turnNumber: number;
  readonly contextWindow: number;
  readonly contextModelId: string;
  readonly configuredModelId: string;
  readonly isAutoRouted: boolean;
  /** Who this turn is for: the context gate's measure reads it. */
  readonly counterparty: TurnCounterparty;
  readonly broadcast: (event: WsEvent) => void;
  /** A closure over driver state; passed as a value, it keeps its live bindings. */
}

/** The order is the contract: a stopped turn must not park or measure a context. */
export async function runPreCallGates(
  state: AgentTurnState,
  ctx: PreCallGatesContext,
): Promise<StepOutcome> {
  const { agentId } = ctx;

  // The stop flag is only read here: the run's own `finally` clears it, so a stale flag cannot kill the
  // next turn. No idle status write here (teardown owns it); `latchEngineCut` records the cause.
  if (isStopFenced(agentId)) {
    logger.info('v2 agent stopped by user', {}, agentId);
    return requestExit(latchEngineCut(state, 'stop'), 'stopped-by-user' satisfies PreCallGatesExitReason);
  }
  if (preemptedAgents.has(agentId)) {
    preemptedAgents.delete(agentId);
    logger.info('v2 run preempted, queued wakeup will fire', {}, agentId);
    return requestExit(latchEngineCut(state, 'preempt'), 'preempted' satisfies PreCallGatesExitReason);
  }

  const budget = await runTurnTimeBudget(state, ctx);
  if (budget.directive !== 'proceed') return budget;

  const context = await runContextGates(budget.state, ctx);
  if (context.directive !== 'proceed') return context;

  return proceed(context.state);
}
