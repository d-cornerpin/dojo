// ════════════════════════════════════════════════════════════════════════════════════════
// t168 (v3.3.3 run 9) — A SURRENDER FOR A FULL CONTEXT WAITS FOR THE EVENT THAT CAN CHANGE IT.
//
// The context gate's emergency (96-99%) and block (99%+) arms both end the same way: run one forced
// compaction pass, park the job, queue a wake, leave the turn. The wake exists so "the next iteration
// assembles fresh post-compaction context". When the pass reclaimed, that is true. When the pass was
// SKIPPED by the compaction brake (or ran and won nothing, which arms it), nothing about the next
// assembly differs: same rows, same summaries, same brake, so the wake ran the same gate half a second
// later and surrendered again. 1,216 times in twelve minutes on a user's box, until the agent was
// terminated.
//
// So the park's wake is queued by what can change the answer, and by nothing else:
//   · no brake binds a forced pass (the pass reclaimed, or was cancelled, which arms none): the wake is
//     queued now, exactly as before;
//   · the brake binds: the wake is the park's own timer wake, set for the brake's expiry
//     (`compactionBrakeMsLeft`, the clock the brake already carries; no number of this file's). Any
//     earlier event reaches the agent through its own door (the owner's message, a reset, a new model),
//     and each of those gets one surrender of its own, no more.
//
// AT THE EXPIRY the brake has let go, so the wake's gate runs a real forced pass. If it reclaims, the
// agent continues as it always did. If it runs and reclaims nothing, the agent is stuck for a reason the
// platform cannot repair by itself: the owner is told ONCE, through the door the Healer's stuck cases
// already use (`stuck:<agent>`: one text, one standing card, same words: "I'll keep trying in the
// background. You can also send a message or reset its session"), and the waits go on at each expiry,
// silently. The condition ends when a pass reclaims or the context fits again, and a later incident is
// told afresh. A park stays invisible housekeeping: nothing is written to the agent's chat.
//
// requirement preserved: "emergency means first, not infinite, and never terminal" (compaction-brakes.ts,
// OR-COMPACT-1): the brake still lets go on the clock, a reset, a new model, a shrunken history and the
// writer answering again; the agent is never parked on a lock that only a click can lift.
// ════════════════════════════════════════════════════════════════════════════════════════

import { createLogger } from '../../logger.js';
import { compactionBrakeMsLeft } from '../../memory/compaction-brakes.js';
import { parkJob } from '../../work/job-continuation.js';
import { tellOwnerOnce, ownerConditionCleared, wordsOf } from '../../healer/owner-notices.js';
import { sendAlert } from '../../services/imessage-bridge.js';

const logger = createLogger('v2-context-wait');

/** Agents whose last surrender was held for the brake's expiry (so the next pass that runs is the one the wait was for). */
const waiting = new Set<string>();
/** Agents the owner was told are stuck on this incident (so its end clears the record, and only ours). */
const told = new Set<string>();

/**
 * PARK THE JOB AFTER A FORCED PASS, with the wake that fits what the pass left behind.
 * `brakedBefore`: the brake already bound a forced pass when the gate asked, so the pass was skipped
 * rather than run (asked by the caller before it called `checkAndCompact`).
 */
export function parkAfterForcedPass(agentId: string, reason: string, brakedBefore: boolean): void {
  const msLeft = compactionBrakeMsLeft(agentId);
  if (msLeft === null) {
    endFullContextWait(agentId);
    parkJob(agentId, reason);
    return;
  }
  // A pass that RAN in this very gate and left the brake on, after a wait for it, is the expiry's pass failing.
  if (!brakedBefore && waiting.has(agentId)) tellStuckOnce(agentId);
  waiting.add(agentId);
  logger.info('Context is full and compaction is braked: the wake waits for the brake to let go', { msLeft }, agentId);
  parkJob(agentId, reason, 'timer', msLeft);
}

/** The wait is over: a pass reclaimed, or the context fits again. Ends the owner's condition if we raised it. */
export function endFullContextWait(agentId: string): void {
  waiting.delete(agentId);
  if (told.delete(agentId)) ownerConditionCleared(`stuck:${agentId}`);
}

function tellStuckOnce(agentId: string): void {
  const key = `stuck:${agentId}`;
  if (!tellOwnerOnce(key)) return;
  told.add(agentId);
  try {
    sendAlert(wordsOf(key), 'notice');
  } catch (err) {
    logger.warn('could not text the owner that a full agent is stuck', { error: err instanceof Error ? err.message : String(err) }, agentId);
  }
}

/** Test-only reset; both sets are per-process. */
export function __resetFullContextWaitForTests(): void {
  waiting.clear();
  told.clear();
}
