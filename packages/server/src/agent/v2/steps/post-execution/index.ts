// Post-execution floors (repetition, permission-denial and no-results counters, spinning nudge). A module
// cannot break its caller's loop, so each exit is a StepOutcome directive the driver honours.
// The logger keeps component name `v2-loop`: operators grep the structured log sink by it.

import type { WsEvent } from '@dojo/shared';
import { createLogger } from '../../../../logger.js';
import {
  advance,
  type AgentTurnState,
  type ModelCallResult,
  type ToolResultRecord,
  type TurnPhase,
} from '../../state.js';
import { steerFired, steerFireCount } from '../../steer-queue.js';
import { persistEngineSteer } from '../../engine-steer.js';
import { progressClassifier, buildSpinningNudge } from '../../classifiers/progress.js';
import { agentCanSelfCompleteById } from '../../../tools/util.js';
import { continueLoop, proceed, requestExit, type StepOutcome } from '../step-outcome.js';
import { userWords, currentAddress } from '../../turn-address.js';

const logger = createLogger('v2-loop');

/** The phase the driver advances into before calling this step. */
export const POST_EXECUTION_PHASE: TurnPhase = 'postExecution';

/** Why this step asked the driver to leave the loop. */
export type PostExecutionExitReason = 'stuck-repeating' | 'no-results' | 'spinning-nudge-cap';

export interface PostExecutionContext {
  readonly agentId: string;
  readonly turnNumber: number;
  /** THIS iteration's model result. Read, never written. */
  readonly result: Pick<ModelCallResult, 'content' | 'toolCalls'>;
  /** THIS iteration's tool results, in execution order. Read, never written. */
  readonly turnToolResults: readonly ToolResultRecord[];
  readonly broadcast: (event: WsEvent) => void;
}

/**
 * Every `state` reassignment goes through `advance`, so `validate()` runs on each one;
 * the returned outcome carries the last value.
 */
export function runPostExecution(state: AgentTurnState, ctx: PostExecutionContext): StepOutcome {
  const { agentId, turnNumber, result, turnToolResults, broadcast } = ctx;

  // Same text and same tool calls as last iteration means stuck: nudge once, then exit STUCK_REPEATING.
  // The loopDetector catches repeated tool calls; this also catches repeated text-only responses.
  const currentResponseSig =
    (result.content ?? '') +
    '|' +
    result.toolCalls
      .map((tc) => `${tc.name}:${JSON.stringify(tc.arguments)}`)
      .sort()
      .join(',');
  if (state.lastResponseSig === currentResponseSig) {
    if (!steerFired(state.steerQueue, 'repetition')) {
      logger.warn('v2: agent repeating itself, nudging on next iteration', {
        loopCount: state.loopCount,
      }, agentId);
      // complete_task is not available to every agent, so the steer names work_update instead.
      state = persistEngineSteer(state, {
        agentId, turnNumber, floor: 'repetition', atLoop: state.loopCount,
        content:
          '[System: You are repeating yourself, your last two responses were identical. ' +
          'Try a different approach. If the task is complete, record it with its result (e.g. work_update(action="status")). ' +
          'If you need help, explain what you are stuck on.]',
      }, { broadcast });
      return continueLoop(state);
    }
    logger.warn('v2: breaking tool loop, agent still repeating after nudge', {
      loopCount: state.loopCount,
    }, agentId);
    broadcast({
      type: 'chat:error', cardClass: 'informational',
      agentId,
      error: 'Agent got stuck repeating itself. Send a follow-up to redirect it.',
      code: 'STUCK_REPEATING',
      severity: 'warning',
      retryable: true,
    });
    return requestExit(state, 'stuck-repeating' satisfies PostExecutionExitReason);
  }
  state = advance(state, { lastResponseSig: currentResponseSig });

  // Permission denial counter
  const allBlocked = turnToolResults.every((tr) => tr.isError && tr.content.includes('[BLOCKED]'));
  if (allBlocked && turnToolResults.length > 0) {
    state = advance(state, {
      consecutivePermissionDenials: state.consecutivePermissionDenials + turnToolResults.length,
    });
  } else if (turnToolResults.length > 0) {
    state = advance(state, { consecutivePermissionDenials: 0 });
  }

  // Search tools that keep returning "No results found" / "not in memory": nudge once, then exit NO_RESULTS.
  const allNoResults =
    turnToolResults.length > 0 &&
    turnToolResults.every(
      (tr) =>
        tr.content.includes('No results found') ||
        tr.content.includes('not in memory'),
    );
  if (allNoResults && turnToolResults.every((tr) => !tr.isError)) {
    const nextNoResultsCount = state.consecutiveNoResultTools + 1;
    if (nextNoResultsCount >= 2) {
      if (!steerFired(state.steerQueue, 'no-results')) {
        logger.warn('v2: consecutive empty search results, nudging on next iteration', {
          loopCount: state.loopCount,
          consecutiveNoResultTools: nextNoResultsCount,
        }, agentId);
        // The steer's latch lives on its queue entry; the counter reset is a separate `advance`.
        state = persistEngineSteer(state, {
          agentId, turnNumber, floor: 'no-results', atLoop: state.loopCount,
          content:
            '[System: Multiple searches returned no results. The information may not exist in memory. ' +
            `Try responding based on what you already know, or ask ${userWords(currentAddress(agentId))} for clarification.]`,
        }, { broadcast });
        state = advance(state, { consecutiveNoResultTools: 0 });
        return continueLoop(state);
      }
      // Already nudged, break with NO_RESULTS error
      logger.warn('v2: breaking tool loop, still no results after nudge', {
        loopCount: state.loopCount,
      }, agentId);
      broadcast({
        type: 'chat:error', cardClass: 'informational',
        agentId,
        error: 'Agent stopped, searches kept coming up empty. The info may not be in memory yet.',
        code: 'NO_RESULTS',
        severity: 'warning',
        retryable: true,
      });
      return requestExit(state, 'no-results' satisfies PostExecutionExitReason);
    }
    state = advance(state, { consecutiveNoResultTools: nextNoResultsCount });
  } else if (turnToolResults.length > 0) {
    state = advance(state, { consecutiveNoResultTools: 0 });
  }

  // Spinning detection: the engine asks the model before breaking.
  const progressDecision = progressClassifier({
    toolCallsExecutedThisTurn: state.toolCallsExecutedThisTurn,
    // Both zeros are deliberate. Nothing produces consecutiveSmallDeltas. The no-results floor above resets
    // or exits at 2, below the classifier's threshold of 3, so passing that counter would be dead.
    consecutiveSmallDeltas: 0,
    consecutivePermissionDenials: state.consecutivePermissionDenials,
    consecutiveNoResultTools: 0,
    // The spinning nudge count is read off the steer queue's own fire count; the queue is the latch.
    spinningNudgeCount: steerFireCount(state.steerQueue, 'spinning'),
    loopCount: state.loopCount,
  });
  if (!progressDecision.progressing) {
    if (progressDecision.signals?.includes('nudge cap')) {
      logger.warn('v2: spinning nudge cap reached, breaking', { agentId }, agentId);
      return requestExit(state, 'spinning-nudge-cap' satisfies PostExecutionExitReason);
    }
    // Names complete_task only for agents that can self-complete; others are told to explain the block.
    const nudgeText = buildSpinningNudge({
      toolCallsExecutedThisTurn: state.toolCallsExecutedThisTurn,
      consecutiveSmallDeltas: 0,
      consecutivePermissionDenials: state.consecutivePermissionDenials,
      consecutiveNoResultTools: 0,
      spinningNudgeCount: steerFireCount(state.steerQueue, 'spinning'),
      loopCount: state.loopCount,
    }, agentCanSelfCompleteById(agentId));
    // Sent as an engine steer so the model actually hears the question and the dashboard keeps its row.
    // Keyed per loop: this floor is deliberately not one-shot (capped by MAX_SPINNING_NUDGES).
    state = persistEngineSteer(
      state,
      { agentId, content: nudgeText, turnNumber, floor: 'spinning', key: `loop-${state.loopCount}`, atLoop: state.loopCount },
      { broadcast },
    );
  }

  return proceed(state);
}
