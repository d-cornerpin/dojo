// "Would a stop cut anything?" asked once: live `background` registrations, open job rows and queued replies.
// `agents.status` answers whether a turn is in flight: a different question, deliberately unused.

import { countAbortable } from './shared-state.js';
import { getDb } from '../db/connection.js';
import { broadcast } from '../gateway/ws.js';
import { TERMINAL_JOB_STATUS_SQL } from '../services/media-job-status.js';
import { pendingReplies } from './v2/channel-sender.js';
import { workingExpr } from '../work/terminal-states.js';

/** The shape already on the wire (`AgentDetail.inFlight`) and in the dashboard rule (`StopSubject`). */
export interface LiveWork {
  readonly turn: number;
  readonly background: number;
}

/** True when ANYTHING is in flight for this agent. THE predicate; nothing re-derives it. */
export function hasLiveWork(w: LiveWork): boolean {
  return w.turn > 0 || w.background > 0;
}

// Rows count because a pre-dial wait registers nothing. Open = NOT terminal (an enumerated list misses a later
// status); stale rows close at boot in services/job-orphans.ts. Every failure is zero, never a throw.
function openJobRows(agentId: string): number {
  let n = 0;
  try {
    n += (getDb().prepare(
      `SELECT COUNT(*) AS n FROM generation_jobs WHERE agent_id = ? AND status NOT IN (${TERMINAL_JOB_STATUS_SQL})`,
    ).get(agentId) as { n: number }).n;
  } catch { /* no table, no db, no claim */ }
  try {
    n += (getDb().prepare(
      `SELECT COUNT(*) AS n FROM video_jobs WHERE agent_id = ? AND status NOT IN (${TERMINAL_JOB_STATUS_SQL})`,
    ).get(agentId) as { n: number }).n;
  } catch { /* as above */ }
  return n;
}

/** The agent's parked jobs: working tasks with a due time, not held. */
export function parkedJobs(agentId: string): Array<{ id: string; dueAt: number }> {
  return getDb().prepare(`SELECT w.id, w.next_attempt_at AS dueAt FROM work w WHERE w.agent_id = ? AND w.kind <> 'ask'
    AND w.next_attempt_at IS NOT NULL AND w.hold_kind IS NULL AND ${workingExpr('w')}`).all(agentId) as Array<{ id: string; dueAt: number }>;
}

/** A pure read, never a writer. A job has a registration AND a row: count the max, never the sum. A reply
 *  waiting to go out, and a job parked between stretches, are live work of their own. */
export function liveWork(agentId: string): LiveWork {
  return {
    turn: countAbortable(agentId, 'turn'),
    background: Math.max(countAbortable(agentId, 'background'), openJobRows(agentId)) + pendingReplies(agentId).length
      + parkedJobs(agentId).length,
  };
}

/** Lifecycle-edge emission: frames carry the ANSWER, not raw material a client would re-tally. */
export function announceLiveWork(agentId: string): void {
  try {
    const w = liveWork(agentId);
    broadcast({
      type: 'agent:jobs',
      agentId,
      turn: w.turn,
      background: w.background,
      stoppable: hasLiveWork(w),
    });
  } catch { /* never let a frame break the work it describes */ }
}
