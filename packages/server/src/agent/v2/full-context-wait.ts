// A surrender for a full context waits for the one event that can change it (never a clock of ours, never
// a click-only park): no immediate wake while a brake binds or a writer is missing (the next assembly is
// identical); the wake is the brake's expiry or a writer returning.

import { createLogger } from '../../logger.js';
import { compactionBrakeMsLeft } from '../../memory/compaction-brakes.js';
import { spanWaitsForAWriter, whenAWriterCanRun } from '../../memory/writer.js';
import { parkJob } from '../../work/job-continuation.js';
import { whenLockFree } from '../../db/with-lock.js';
import { tellOwner, ownerConditionCleared, wordsOf } from '../../healer/owner-notices.js';
import { sendAlert } from '../../services/imessage-bridge.js';

const logger = createLogger('v2-context-wait');

/** Agents whose last surrender was held for the brake's expiry: the next pass that runs is the wait's. */
const waiting = new Set<string>();
/** Agents the owner was told are stuck on this incident (so its end clears the record, and only ours). */
const told = new Set<string>();

export function parkAfterForcedPass(agentId: string, reason: string, brakedBefore: boolean, opts: { quiet?: boolean } = {}): void {
  if (spanWaitsForAWriter(agentId)) {
    logger.info('Context is full and no summary writer can run: the wake waits for one to be back', { reason }, agentId);
    parkJob(agentId, reason, 'event', whenAWriterCanRun(agentId));
    return;
  }
  const msLeft = compactionBrakeMsLeft(agentId);
  if (msLeft === null) {
    endFullContextWait(agentId);
    parkJob(agentId, reason, Date.now());
    return;
  }
  // A pass that RAN here and left the brake on, after a wait, is the expiry's pass failing. `quiet` is
  // the over-budget door: its failing pass already tells the owner through the compaction card.
  if (!opts.quiet && !brakedBefore && waiting.has(agentId)) tellStuckOnce(agentId);
  waiting.add(agentId);
  logger.info('Context is full and compaction is braked: the wake waits for the brake to let go', { msLeft }, agentId);
  parkJob(agentId, reason, Date.now() + msLeft);
}

/** A TURN NEVER WAITS ON ANOTHER COMPACTION'S LOCK: a pass that found it held parks here until it lands. */
export function parkUntilCompactionLands(agentId: string, reason: string): void {
  logger.info('Another compaction holds the lock: the turn does not wait on it; the wake is that pass landing', { reason }, agentId);
  parkJob(agentId, reason, 'event', whenLockFree(`compact:${agentId}`));
}

export function endFullContextWait(agentId: string): void {
  waiting.delete(agentId);
  if (told.delete(agentId)) ownerConditionCleared(`stuck:${agentId}`);
}

function tellStuckOnce(agentId: string): void {
  const key = `stuck:${agentId}`;
  if (!tellOwner(key, wordsOf(key))) return;
  told.add(agentId);
  try {
    void sendAlert(wordsOf(key), 'notice', { kind: 'broken-agent', agentId });
  } catch (err) {
    logger.warn('could not text the owner that a full agent is stuck', { error: err instanceof Error ? err.message : String(err) }, agentId);
  }
}

export function __resetFullContextWaitForTests(): void {
  waiting.clear();
  told.clear();
}
