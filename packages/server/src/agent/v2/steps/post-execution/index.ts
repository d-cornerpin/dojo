// The dead-end floor: a pass whose every call came back empty or refused. A module cannot break its
// caller's loop, so the exit is a StepOutcome directive the driver honours.
// The logger keeps component name `v2-loop`: operators grep the structured log sink by it.

import type { WsEvent } from '@dojo/shared';
import { createLogger } from '../../../../logger.js';
import {
  advance,
  type AgentTurnState,
  type ToolResultRecord,
  type TurnPhase,
} from '../../state.js';
import { steerFired } from '../../steer-queue.js';
import { persistEngineSteer } from '../../engine-steer.js';
import { continueLoop, proceed, requestExit, type StepOutcome } from '../step-outcome.js';
import { userWords, currentAddress } from '../../turn-address.js';

const logger = createLogger('v2-loop');

/** The phase the driver advances into before calling this step. */
export const POST_EXECUTION_PHASE: TurnPhase = 'postExecution';

/** Why this step asked the driver to leave the loop. */
export type PostExecutionExitReason = 'dead-end';

export interface PostExecutionContext {
  readonly agentId: string;
  readonly turnNumber: number;
  /** THIS iteration's tool results, in execution order. Read, never written. */
  readonly turnToolResults: readonly ToolResultRecord[];
  readonly broadcast: (event: WsEvent) => void;
}

/**
 * Every `state` reassignment goes through `advance`, so `validate()` runs on each one;
 * the returned outcome carries the last value.
 */
export function runPostExecution(state: AgentTurnState, ctx: PostExecutionContext): StepOutcome {
  const { agentId, turnNumber, turnToolResults, broadcast } = ctx;

  // Every call came back empty ("No results found", "not in memory") or refused ([BLOCKED] from a broker, [BLOCKED by engine]
  // from a policy, the overseer's wall or a gate): two such passes in a row steer once, then two more end the turn.
  const deadEnd =
    turnToolResults.length > 0 &&
    turnToolResults.every(
      (tr) => tr.isError
        ? tr.content.includes('[BLOCKED')
        : tr.content.includes('No results found') || tr.content.includes('not in memory'),
    );
  if (deadEnd) {
    const nextDeadEnds = state.deadEndPasses + 1;
    if (nextDeadEnds >= 2) {
      if (!steerFired(state.steerQueue, 'dead-end')) {
        logger.warn('v2: consecutive dead-end passes, nudging on next iteration', {
          loopCount: state.loopCount,
          deadEndPasses: nextDeadEnds,
        }, agentId);
        // The steer's latch lives on its queue entry; the counter reset is a separate `advance`.
        state = persistEngineSteer(state, {
          agentId, turnNumber, floor: 'dead-end', atLoop: state.loopCount,
          content:
            '[System: Your last calls all came back empty or refused. What you need may not be there, or may not be open to you. ' +
            `Try responding based on what you already know, or ask ${userWords(currentAddress(agentId))} for clarification.]`,
        }, { broadcast });
        state = advance(state, { deadEndPasses: 0 });
        return continueLoop(state);
      }
      // Already nudged, break with the NO_RESULTS card
      logger.warn('v2: breaking tool loop, still dead ends after nudge', {
        loopCount: state.loopCount,
      }, agentId);
      broadcast({
        type: 'chat:error', cardClass: 'informational',
        agentId,
        error: 'Agent stopped: its calls kept coming back empty or refused.',
        code: 'NO_RESULTS',
        severity: 'warning',
        retryable: true,
      });
      return requestExit(state, 'dead-end' satisfies PostExecutionExitReason);
    }
    state = advance(state, { deadEndPasses: nextDeadEnds });
  } else if (turnToolResults.length > 0) {
    state = advance(state, { deadEndPasses: 0 });
  }

  return proceed(state);
}
