import { createLogger } from '../logger.js';
import { queueSelfWake } from '../agent/shared-state.js';
import { registerDrainWake, armTimerWake, timerWakeIsSpent, carryJobWork, turnWorkIds } from './task-freshness.js';
import { servedOwnerMessageIds } from '../memory/served-ask.js';
import { parkOrigin } from './job-origin.js';
import { turnContext } from '../agent/turn-context.js';

const logger = createLogger('job-continuation');

/** Turn-budget park's continuation: a self-wake the drain serves; refused (false) while the owner's Stop stands. */
export function queueJobContinuation(agentId: string, reason: string): boolean {
  const queued = queueSelfWake(agentId, reason);
  if (queued) registerDrainWake(agentId);
  return queued;
}

/** A timer park's continuation: its own timer (a second lets the park's DB writes settle),
 *  which starts a run FROM that wake. */
export function armToolLoopContinuation(agentId: string, delayMs = 1000, after?: Promise<unknown>): void {
  const wake = armTimerWake(agentId);
  const go = (): unknown => setTimeout(() => {
    if (timerWakeIsSpent(agentId, wake)) {   // the drain already started this park's continuation
      logger.info('park timer wake not run: its continuation already started', { agentId }, agentId);
      return;
    }
    void import('../agent/runtime.js')
      .then((m) => m.getAgentRuntime().handleMessage(agentId, '', { job: true }))
      .catch((err: unknown) => {
        logger.error('v2 auto-continuation after tool limit failed', { agentId, error: err instanceof Error ? err.message : String(err) }, agentId);
      });
  }, delayMs);
  if (after) void after.then(go, go); else go();   // the wake waits for that promise, not a clock
}

/** THE ONE DEFINITION OF "PARK": carry the job's tasks, the owner messages the turn served and where the job
 *  started onto the job record, then queue exactly one continuation: on the drain's wake set, or for `'timer'`
 *  on its own timer (`delayMs` / `after` hold it for an event). Every site that parks a job calls this. */
export function parkJob(agentId: string, reason: string, how: 'drain' | 'timer' = 'drain', delayMs?: number, after?: Promise<unknown>): boolean {
  const named = turnWorkIds(agentId);
  const served = servedOwnerMessageIds(agentId);
  carryJobWork(agentId, named, served, parkOrigin(agentId, named, served));   // a task-less park still gets a job
  const queued = how === 'timer' ? (armToolLoopContinuation(agentId, delayMs, after), true) : queueJobContinuation(agentId, reason);
  const bag = turnContext(agentId);
  if (queued && bag) bag.jobParked = true;   // the end-of-turn nets read this (`turnParkedTheJob`)
  return queued;
}
