import { lastTurnEnd, recordContinued, recordStalled } from '../../../../work/job-momentum.js';
import { parkJob } from '../../../../work/job-continuation.js';
import { noteEngineCheckpoint } from '../../../../work/engine-checkpoint-note.js';
import { readJobAtPassEnd } from './job-turn-end.js';
import { createLogger } from '../../../../logger.js';
import type { AgentTurnState } from '../../state.js';
import type { PostCallClassifyContext, PostCallScratch } from './index.js';

const logger = createLogger('v2-loop');

export type JobTurnEnd = 'continued' | 'stalled';

/** Parks and continues a measured job whose turn ended with items left and momentum; a continued turn
 *  without momentum records a stall for the PM. Null when the going-idle detector's other branches decide. */
export async function continueTheJob(state: AgentTurnState, ctx: PostCallClassifyContext, sc: PostCallScratch): Promise<JobTurnEnd | null> {
  const { agentId, turnNumber } = ctx;
  // A human still owed a reply gets the reply first, as does an armed close-out gate left unanswered.
  if (ctx.triggerRow && !(sc.persistedContent ?? '').trim()) return null;
  if (ctx.turnCtx.jobParked) return null;   // this turn already parked its job (another park)
  const job = await readJobAtPassEnd(state, ctx);
  // Only a measured job with items left continues (0 = finished; never read = nothing to go on).
  if (!job?.measure || job.remaining === null || job.remaining <= 0) return null;
  const { taskId, remaining, touchedThisTurn, novelCallsThisTurn } = job;

  if (job.momentum) {
    // Noted on the activity line, not last-moved time: a park is not progress, so the PM sees a stopped job.
    try { noteEngineCheckpoint(agentId, 'job-continues', [taskId]); } catch (err) {
      logger.warn('v2: job-continues checkpoint note failed (non-fatal)', { agentId, error: err instanceof Error ? err.message : String(err) }, agentId);
    }
    parkJob(agentId, `job continues: ${remaining} remain`, Date.now());
    recordContinued(taskId, { remaining, touchedThisTurn, novelCallsThisTurn, turnNumber });
    logger.info('v2 job continues: turn ended mid-job with momentum, parked', { agentId, taskId, remaining, touchedThisTurn, novelCallsThisTurn }, agentId);
    return 'continued';
  }
  // Only a turn started from the job counts as its continuation, so only it can be a stall.
  if (lastTurnEnd(taskId)?.kind === 'continued' && ctx.turnCtx.servedJob) {
    recordStalled(taskId, { remaining, turnNumber });
    logger.info('v2 job stalled: a continued turn made no progress; left in progress for the PM', { agentId, taskId, remaining }, agentId);
    return 'stalled';
  }
  return null;
}
