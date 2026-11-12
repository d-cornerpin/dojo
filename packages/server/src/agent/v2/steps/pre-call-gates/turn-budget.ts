// The turn-time budget: past 15 minutes a turn checkpoints (token-math compaction check, tracker note,
// park for a fresh continuation), as often as the job needs; elapsed time alone never means trouble.

import { createLogger } from '../../../../logger.js';
import { agentTurnWindow } from '../../../../router/router-window.js';
import { checkAndCompact } from '../../../../memory/compaction.js';
import { turnContinuationCounts, isStopFenced } from '../../../shared-state.js';
import { type AgentTurnState } from '../../state.js';
import { proceed, requestExit, type StepOutcome } from '../step-outcome.js';
import { latchEngineCut } from '../../engine-exit.js';
import { noteEngineCheckpoint } from '../../../../work/engine-checkpoint-note.js';
import { parkJob } from '../../../../work/job-continuation.js';
import type { PreCallGatesContext, PreCallGatesExitReason } from './index.js';

const logger = createLogger('v2-loop');

const TURN_TIME_BUDGET_MS = 15 * 60 * 1000;    // 15 min per turn

export async function runTurnTimeBudget(
  state: AgentTurnState,
  ctx: PreCallGatesContext,
): Promise<StepOutcome> {
  const {
    agentId, turnNumber, configuredModelId, stashContinuationIfHuman,
  } = ctx;

  // The park counter only numbers parks for the operator's log; nothing decides on it.
  if (Date.now() - state.turnStartMs > TURN_TIME_BUDGET_MS) {
    const elapsedMin = Math.round((Date.now() - state.turnStartMs) / 60000);
    const continuationCount = (turnContinuationCounts.get(agentId) ?? 0) + 1;
    const effectiveModel =
      state.modelId === '__auto__' ? configuredModelId : state.modelId;

    turnContinuationCounts.set(agentId, continuationCount);
    logger.warn('v2 turn time budget reached, auto-continuing', {
      elapsedMin, continuationCount, agentId,
    }, agentId);

    // No `force`: the token math decides. Elapsed time alone must never rebuild an agent's history.
    let historyWasRebuilt = false;
    try {
      const compaction = await checkAndCompact(agentId, effectiveModel, agentTurnWindow(agentId, effectiveModel));
      historyWasRebuilt = compaction.leafCreated > 0 || compaction.condensedCreated > 0;
      // No recap steer here: this step exits the turn and the steer queue is per-turn, so none is read.
      // `historyWasRebuilt` tells a checkpoint that compacted from one that (correctly) did not.
      logger.info('v2 turn-budget checkpoint: the turn parks for a continuation', {
        agentId, turnNumber, toolCallsSoFar: state.toolResults.length, historyWasRebuilt,
      }, agentId);
    } catch (compErr) {
      logger.warn('v2 compaction check at turn-budget checkpoint failed', {
        agentId, error: compErr instanceof Error ? compErr.message : String(compErr),
      }, agentId);
    }

    // Re-read the stop: the compaction above can run for minutes, and a stop that landed inside it
    // must not park the job or queue a continuation.
    if (isStopFenced(agentId)) {
      logger.info('v2 turn-budget checkpoint: the user stopped this agent during the compaction check; not parking and not queuing a continuation', {
        agentId, turnNumber, continuationCount,
      }, agentId);
      turnContinuationCounts.delete(agentId);
      // `stop` is the cause a person took; `latchEngineCut` is first-writer-wins, so an earlier latch stands.
      return requestExit(latchEngineCut(state, 'stop'), 'stopped-by-user' satisfies PreCallGatesExitReason);
    }

    // No park row and no broadcast here: the checkpoint carries the job to its continuation and notes its tasks.
    try {
      noteEngineCheckpoint(agentId, 'turn-budget');
    } catch (checkpointErr) {
      logger.warn('v2: engine-checkpoint tracker note failed (non-fatal)', {
        agentId, error: checkpointErr instanceof Error ? checkpointErr.message : String(checkpointErr),
      }, agentId);
    }
    stashContinuationIfHuman(); // carry the human conversation into the continuation
    parkJob(agentId, 'turn-budget-continuation');   // the job travels on this wake
    // An engine cut (`budget`), not `no_reply_intended`: a long job must not spend the re-serve ladder.
    return requestExit(latchEngineCut(state, 'budget'), 'turn-time-budget' satisfies PreCallGatesExitReason);
  }
  return proceed(state);
}
