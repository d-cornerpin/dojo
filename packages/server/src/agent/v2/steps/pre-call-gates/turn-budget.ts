// The one place a turn parks itself: at the end of a checkpoint window a moving job renews it unless a person is
// waiting; otherwise the turn checkpoints (tracker note, park for a fresh continuation).
// A continuation whose window moved nothing does not park again: its task records the stall for the ladder.

import { createLogger } from '../../../../logger.js';
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
  const { agentId, turnNumber } = ctx;

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
    logger.info('v2 turn-budget checkpoint: the turn parks for a continuation', { agentId, turnNumber, loopCount: state.loopCount }, agentId);
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
