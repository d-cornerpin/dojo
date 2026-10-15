// ════════════════════════════════════════════════════════════════════════════════════════
// THE PARK'S OWN CONTINUATION WAKE (t143 round 6).
// A park queues exactly one continuation, and the job's task ids travel ON it (see
// `task-freshness.ts`): these two helpers are the only ways a park queues one, and each registers the
// wake it makes. Only a run launched from that wake carries the job.
// ════════════════════════════════════════════════════════════════════════════════════════

import { createLogger } from '../logger.js';
import { queueSelfWake } from '../agent/shared-state.js';
import { registerDrainWake, armTimerWake, timerWakeIsSpent, carryJobWork, turnWorkIds } from './task-freshness.js';
import { servedOwnerMessageIds } from '../memory/served-ask.js';
import { turnContext } from '../agent/turn-context.js';

const logger = createLogger('job-continuation');

/** The turn-budget park's continuation: a self-wake on the shared set the runtime's drain serves.
 *  Refused (false) while the owner's Stop stands; nothing is registered then. */
export function queueJobContinuation(agentId: string, reason: string): boolean {
  const queued = queueSelfWake(agentId, reason);
  if (queued) registerDrainWake(agentId);
  return queued;
}

/** The tool-loop park's continuation: its own timer (a second lets the park's DB writes settle),
 *  which starts a run FROM that wake. */
export function armToolLoopContinuation(agentId: string, delayMs = 1000): void {
  const wake = armTimerWake(agentId);
  setTimeout(() => {
    if (timerWakeIsSpent(agentId, wake)) {   // t158 E: the drain already started this park's continuation
      logger.info('park timer wake not run: its continuation already started', { agentId }, agentId);
      return;
    }
    void import('../agent/runtime.js')
      .then((m) => m.getAgentRuntime().handleMessage(agentId, '', { job: true }))
      .catch((err: unknown) => {
        logger.error('v2 auto-continuation after tool limit failed', { agentId, error: err instanceof Error ? err.message : String(err) }, agentId);
      });
  }, delayMs);
}

/**
 * THE ONE DEFINITION OF "PARK" (t145 round 6): hand the running job on, then queue the wake that resumes it.
 * Carries the job's own tasks and the owner message(s) the parking turn served on the job record (so a job
 * with no task still has its words re-shown to its continuation, and only to it), then queues exactly one
 * continuation: on the shared wake set the drain serves (`'drain'`) or on the tool-loop park's own timer
 * (`'timer'`). Every site that parks a job calls this and nothing else: the turn-budget park, the tool-loop
 * park, the emergency compaction and context-full block (`context-gates.ts`) and the two forced compactions
 * of error recovery (`recovery.ts`). On a turn that is not a job it carries nothing and is a plain wake.
 * `delayMs` (timer parks only, t168): when the park's wake must wait for a named event rather than for the
 * park's own DB writes to settle, such as the compaction brake's expiry for a context that is full.
 */
export function parkJob(agentId: string, reason: string, how: 'drain' | 'timer' = 'drain', delayMs?: number): boolean {
  carryJobWork(agentId, turnWorkIds(agentId), servedOwnerMessageIds(agentId));
  const queued = how === 'timer' ? (armToolLoopContinuation(agentId, delayMs), true) : queueJobContinuation(agentId, reason);
  const bag = turnContext(agentId);
  if (queued && bag) bag.jobParked = true;   // t159 G2: the running turn parked the job; the end-of-turn nets read this (`turnParkedTheJob`)
  return queued;
}
