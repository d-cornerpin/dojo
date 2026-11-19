// The one place a turn parks itself: at the end of a checkpoint window a moving job renews it unless a person is
// waiting; otherwise the turn checkpoints (token-math compaction check, tracker note, park for a fresh continuation).
// A continuation whose window moved nothing does not park again: its task records the stall for the ladder.

import { createLogger } from '../../../../logger.js';
import { agentTurnWindow } from '../../../../router/router-window.js';
import { checkAndCompact } from '../../../../memory/compaction.js';
import { isStopFenced } from '../../../shared-state.js';
import { getDb } from '../../../../db/connection.js';
import { advance, type AgentTurnState } from '../../state.js';
import { jobProgressMark, jobTaskOf, personWaitsBehind, stretchMoved, turnWindow } from '../post-call-classify/job-turn-end.js';
import { proceed, requestExit, type StepOutcome } from '../step-outcome.js';
import { latchEngineCut } from '../../engine-exit.js';
import { noteEngineCheckpoint } from '../../../../work/engine-checkpoint-note.js';
import { parkJob } from '../../../../work/job-continuation.js';
import { recordStalled } from '../../../../work/job-momentum.js';
import { turnContext } from '../../../turn-context.js';
import type { PreCallGatesContext, PreCallGatesExitReason } from './index.js';

const logger = createLogger('v2-loop');

export async function runTurnTimeBudget(
  state: AgentTurnState,
  ctx: PreCallGatesContext,
): Promise<StepOutcome> {
  const {
    agentId, turnNumber, configuredModelId,
  } = ctx;

  const window = turnWindow(state, agentId);
  if (window === 'renew') {
    return proceed(advance(state, { checkpointWindow: { atLoop: state.loopCount - 1, atMs: Date.now(), mark: jobProgressMark(state, agentId, getDb()) } }));
  }
  if (window === 'checkpoint') {
    if (turnContext(agentId)?.servedJob && !stretchMoved(state, agentId) && !personWaitsBehind(agentId)) {
      const task = jobTaskOf(agentId, getDb());
      if (task) recordStalled(task.id, { remaining: task.stored, turnNumber });
      logger.info('v2 checkpoint: a continuation that moved nothing ends without parking', { agentId, turnNumber, taskId: task?.id }, agentId);
      return requestExit(latchEngineCut(state, 'iteration_cap'), 'turn-time-budget' satisfies PreCallGatesExitReason);
    }
    const elapsedMin = Math.round((Date.now() - state.turnStartMs) / 60000);
    const effectiveModel =
      state.modelId === '__auto__' ? configuredModelId : state.modelId;

    logger.warn('v2 checkpoint window ended, auto-continuing', {
      elapsedMin, loopCount: state.loopCount, agentId,
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
        agentId, turnNumber,
      }, agentId);
      // `stop` is the cause a person took; `latchEngineCut` is first-writer-wins, so an earlier latch stands.
      return requestExit(latchEngineCut(state, 'stop'), 'stopped-by-user' satisfies PreCallGatesExitReason);
    }

    // No park row and no broadcast here: the checkpoint notes the job's tasks and the park dates its task.
    try {
      noteEngineCheckpoint(agentId, 'turn-budget');
    } catch (checkpointErr) {
      logger.warn('v2: engine-checkpoint tracker note failed (non-fatal)', {
        agentId, error: checkpointErr instanceof Error ? checkpointErr.message : String(checkpointErr),
      }, agentId);
    }
    parkJob(agentId, 'turn-budget-continuation', Date.now());
    // An engine cut, not `no_reply_intended`: a long job must not spend the re-serve ladder.
    return requestExit(latchEngineCut(state, 'iteration_cap'), 'turn-time-budget' satisfies PreCallGatesExitReason);
  }
  return proceed(state);
}
