// ════════════════════════════════════════════════════════════════════════════════════════
// t166 — AN AGENT THE OWNER OR THE PLATFORM ENDS STOPS, AND NOTHING IT STARTED REACHES ANYONE.
//
// THE MEASURED DEFECT (dev box, 2026-10-14): a helper was terminated mid-turn ("Agent
// terminated" 05:41:42), and its running turn carried on regardless: a history search, a shell
// call, a task opened, and at 05:43:53 an A2A ANSWER that the engine relayed to the owner inside
// another conversation's window. `terminateAgent` archived the conversation, wrote the status,
// auto-paused the work and cleared the timer; it never stopped the run in flight.
//
// THE FIX IS NOT A SECOND STOP. `terminateAgent` calls the owner's own `stopAgent`, and the
// run-scoped fence that Stop raises (`isStopFenced`) is what already makes the pre-call gate, the
// model call and the executor's batch loop stand down. This module holds the two facts the
// callers need and the engine did not have:
//
//   `runIsLive`      — is there anything for a Stop to cut? The SAME question the Stop route asks
//                      (a working row, a live abort registration or open media job, a run still
//                      unwinding), so terminating an idle agent does not write a stop marker for
//                      a turn that never happened.
//   `endedMidRun`    — the agent's row reads `terminated` AND the stop fence of the run it was
//                      ended in is still standing. The BACKSTOP for the seams a stopped run
//                      still reaches: a delivery already past its last fence check (the
//                      embedding await inside the A2A door), a parallel batch already dispatched.
//
// WHY `endedMidRun` AND NOT STATUS ALONE AT THE A2A DOOR: an agent that FINISHES its own task is
// also `terminated`, and the engine speaks for it afterwards (the assignee's close-out relay
// fires 20 s after the close, from a terminated sender, with no run in flight). Status alone
// would silence that hand-back. The fence is raised only by a Stop, so it tells "ended while it
// was running" apart from "finished and spoken for", without reading a single name.
// ════════════════════════════════════════════════════════════════════════════════════════

import { getDb } from '../db/connection.js';
import { createLogger } from '../logger.js';
import type { ToolCall } from '@dojo/shared';
import { isRunUnwinding, isStopFenced } from './shared-state.js';
import { hasLiveWork, liveWork } from './live-work.js';

/** The agent row's status word, or undefined when there is no row. */
function statusOf(agentId: string): string | undefined {
  return (getDb().prepare('SELECT status FROM agents WHERE id = ?').get(agentId) as { status?: string } | undefined)?.status;
}

/** Is there anything a Stop would cut for this agent right now? (The Stop route's own question.) */
export function runIsLive(agentId: string): boolean {
  return statusOf(agentId) === 'working' || hasLiveWork(liveWork(agentId)) || isRunUnwinding(agentId);
}

const logger = createLogger('ended-mid-run');

/** Does the row read `terminated`? */
function isTerminated(agentId: string): boolean {
  return statusOf(agentId) === 'terminated';
}

/**
 * The result a tool call gets when its agent has been terminated, or null when it may run.
 * Read off the row's status, never a name. An agent that ends ITSELF with `complete_task` earlier
 * in the same response (`completedItself`) is the one legitimate way to be terminated mid-turn, so
 * the calls it batched alongside (a hand-back send) are left alone.
 */
export function refusalForTerminated(
  tc: ToolCall, agentId: string, completedItself: boolean,
): { toolCallId: string; name: string; content: string; isError: true } | null {
  if (completedItself || !isTerminated(agentId)) return null;
  logger.warn('v2: tool call refused, this agent has been terminated', { agentId, tool: tc.name }, agentId);
  return { toolCallId: tc.id, name: tc.name, content: 'Refused: this agent has been terminated, so no tool runs.', isError: true };
}

/** Ended while running: `terminated`, and the run it was ended in has not finished unwinding. */
export function endedMidRun(agentId: string): boolean {
  return isStopFenced(agentId) && isTerminated(agentId);
}
