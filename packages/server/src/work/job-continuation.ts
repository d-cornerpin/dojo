// ════════════════════════════════════════════════════════════════════════════════════════
// THE PARK'S OWN CONTINUATION WAKE (t143 round 6).
// A park queues exactly one continuation, and the job's task ids travel ON it (see
// `task-freshness.ts`): these two helpers are the only ways a park queues one, and each registers the
// wake it makes. Only a run launched from that wake carries the job.
// ════════════════════════════════════════════════════════════════════════════════════════

import { createLogger } from '../logger.js';
import { queueSelfWake } from '../agent/shared-state.js';
import { registerDrainWake, registerTimerWake } from './task-freshness.js';

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
  registerTimerWake(agentId);
  setTimeout(() => {
    void import('../agent/runtime.js')
      .then((m) => m.getAgentRuntime().handleMessage(agentId, '', { job: true }))
      .catch((err: unknown) => {
        logger.error('v2 auto-continuation after tool limit failed', { agentId, error: err instanceof Error ? err.message : String(err) }, agentId);
      });
  }, delayMs);
}
