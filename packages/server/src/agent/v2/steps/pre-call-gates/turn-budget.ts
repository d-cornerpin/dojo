// The one place a turn parks itself: at the end of a checkpoint window a moving job renews it, a still one
// checkpoints (token-math compaction check, tracker note, park for a fresh continuation).

import { createLogger } from '../../../../logger.js';
import { agentTurnWindow } from '../../../../router/router-window.js';
import { checkAndCompact } from '../../../../memory/compaction.js';
import { isStopFenced } from '../../../shared-state.js';
import { getDb } from '../../../../db/connection.js';
import { advance, type AgentTurnState } from '../../state.js';
import { jobProgressMark, turnWindow } from '../post-call-classify/job-turn-end.js';
import { proceed, requestExit, type StepOutcome } from '../step-outcome.js';
import { latchEngineCut } from '../../engine-exit.js';
import { noteEngineCheckpoint } from '../../../../work/engine-checkpoint-note.js';
import { parkJob } from '../../../../work/job-continuation.js';
import type { PreCallGatesContext, PreCallGatesExitReason } from './index.js';

const logger = createLogger('v2-loop');

export async function runTurnTimeBudget(
  state: AgentTurnState,
  ctx: PreCallGatesContext,
): Promise<StepOutcome> {
  const {
    agentId, turnNumber, configuredModelId, stashContinuationIfHuman,
  } = ctx;

  const window = turnWindow(state, agentId);
  if (window === 'renew') {
    logger.info('v2 checkpoint window renewed: the job moved', { agentId, turnNumber, loopCount: state.loopCount }, agentId);
    return proceed(advance(state, { checkpointWindow: { atLoop: state.loopCount - 1, atMs: Date.now(), mark: jobProgressMark(state, agentId, getDb()) } }));
  }
  if (window === 'checkpoint') {
    const elapsedMin = Math.round((Date.now() - state.turnStartMs) / 60000);
    const effectiveModel =
      state.modelId === '__auto__' ? configuredModelId : state.modelId;

    logger.warn('v2 checkpoint window passed without the job moving, auto-continuing', {
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
    // An engine cut, not `no_reply_intended`: a long job must not spend the re-serve ladder.
    return requestExit(latchEngineCut(state, 'iteration_cap'), 'turn-time-budget' satisfies PreCallGatesExitReason);
  }
  return proceed(state);
}
