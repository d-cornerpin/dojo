// ════════════════════════════════════════
// v3.5 DONE IS MEASURED, Task D1 — A TURN THAT ENDS MID-JOB IS PARKED AND CONTINUED.
//
// The turn end used to put a menu with "complete" on it in front of a worker whose job still had
// items left, or (when it had already said "500 done so far") just end, leaving the job to the PM's
// check-in. A reply is not a stop signal while items remain, and neither is a status call that was
// refused (the measured close "still returns N"), failed, or aimed at another task: only the job's own
// task really leaving `claimed` or being paused ends the job. Evaluated once per turn end by the
// going-idle detector (`going-idle.ts`), for the job's task (`job-turn-end.ts`), which must carry a
// MEASURE (orchestrator ruling 2: an unmeasured task keeps today's path, the menu and its hint).
//
// THE OWNER'S OWN TURN (orchestrator ruling 1): a job the owner asked for continues by itself too.
// While a human is waiting (the close-out gate's own predicate, `triggerRow`) and the agent has not
// replied yet, today's path stands: the reply comes first. Once it has replied, the turn ends as a
// replied turn ends, its reply untouched, and THEN the continuation is parked like any other. A turn
// that only OPENED the measured task ("on it") has started the job, and that counts as momentum.
//
// MOMENTUM, the reading and the job's task are `job-turn-end.ts`'s (new items touched, a NEW call
// that SUCCEEDED, or the task opened this turn; time plays no part).
//
//   items left on the measure and momentum → park on the timer and record `continued`;
//   items left, no momentum, and this turn WAS the engine's continuation → record `stalled`, park
//     nothing, close nothing: the task stays in progress and unmoved, so the PM's check-in ladder
//     takes it with the count (`tracker/pm-agent.ts`, the closeout-miss report);
//   anything else → null: the detector's existing branches decide (the menu, or the turn ends).
//
// THE LOOP CANNOT RUN WITHOUT PROGRESS: every continued turn must itself show momentum to be
// continued again, and the first continued turn that does not is the stall. Nothing to reset: when
// the worker works again the next turn end re-arms the continuation on its own.
// ════════════════════════════════════════

import { lastTurnEnd, recordContinued, recordStalled } from '../../../../work/job-momentum.js';
import { parkJob } from '../../../../work/job-continuation.js';
import { runCarriesJob } from '../../../../work/task-freshness.js';
import { deliverPendingCirclingVerdict, noteEngineCheckpoint } from '../../../../work/engine-checkpoint-note.js';
import { readJobAtPassEnd } from './job-turn-end.js';
import { createLogger } from '../../../../logger.js';
import type { AgentTurnState } from '../../state.js';
import type { PostCallClassifyContext, PostCallScratch } from './index.js';

const logger = createLogger('v2-loop');

export type JobTurnEnd = 'continued' | 'stalled';

/** The D1 rule at a turn end. Returns what it did, or null when the detector's other branches decide.
 *  The job's task, its reading and its momentum are `job-turn-end.ts`'s, read once for this pass. */
export async function continueTheJob(state: AgentTurnState, ctx: PostCallClassifyContext, sc: PostCallScratch): Promise<JobTurnEnd | null> {
  const { agentId, turnNumber } = ctx;
  // Step 1: a human waiting who has no reply yet gets today's path (the reply comes first), and so does a
  // turn whose close-out gate armed and was not answered (its escalation runs next).
  if (ctx.triggerRow && !(sc.persistedContent ?? '').trim()) return null;
  if (state.danglingTaskIds.length > 0 && !state.closeOutGateSatisfied) return null;
  if (ctx.turnCtx.jobParked) return null;   // this turn already queued its continuation (another park)
  const job = await readJobAtPassEnd(state, ctx);
  // Ruling 2: continuation is for a measured job whose reading shows items left (0 = finished; never read = nothing to go on).
  if (!job?.measure || job.remaining === null || job.remaining <= 0) return null;
  const { taskId, remaining, touchedThisTurn, novelCallsThisTurn } = job;

  if (job.momentum) {
    // The park, as the engine's other checkpoints do it: a pending PM verdict rides to the agent, the
    // job's own task is carried and noted on its record (the activity line; NOT its last-moved time: a
    // park is not progress, so the PM's ladder still sees a job that stops moving), the conversation
    // rides on (C3: an owner's job keeps his channel), then the one park door.
    deliverPendingCirclingVerdict(agentId);
    try { noteEngineCheckpoint(agentId, 'job-continues', [taskId]); } catch (err) {
      logger.warn('v2: job-continues checkpoint note failed (non-fatal)', { agentId, error: err instanceof Error ? err.message : String(err) }, agentId);
    }
    ctx.stashContinuationIfHuman();
    parkJob(agentId, `job continues: ${remaining} remain`, 'timer');
    recordContinued(taskId, { remaining, touchedThisTurn, novelCallsThisTurn, turnNumber });
    // A continuation that touched no item: the PM's ladder is asked HERE, at the boundary between the
    // job's turns (pokes never fire mid-turn), whether its check-in is due (fix round 3).
    if (touchedThisTurn === 0) {
      try { await (await import('../../../../tracker/pm-agent.js')).checkInAtThePark(taskId); } catch (err) {
        logger.warn('v2: check-in at the park failed (non-fatal)', { agentId, error: err instanceof Error ? err.message : String(err) }, agentId);
      }
    }
    logger.info('v2 job continues: turn ended mid-job with momentum, parked', { agentId, taskId, remaining, touchedThisTurn, novelCallsThisTurn }, agentId);
    return 'continued';
  }
  // Only the run the park's own wake started is "the turn the engine continued": an unrelated run
  // that happens to end first is not the continuation, and is never recorded as a stall.
  if (lastTurnEnd(taskId)?.kind === 'continued' && runCarriesJob(agentId)) {
    recordStalled(taskId, { remaining, turnNumber });
    logger.info('v2 job stalled: a continued turn made no progress; left in progress for the PM', { agentId, taskId, remaining }, agentId);
    return 'stalled';
  }
  return null;
}
