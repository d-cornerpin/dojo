
import { getDb } from '../db/connection.js';
import { createLogger } from '../logger.js';
import type { ToolCall } from '@dojo/shared';
import { isRunUnwinding, isStopFenced } from './shared-state.js';
import { hasLiveWork, liveWork } from './live-work.js';

function statusOf(agentId: string): string | undefined {
  return (getDb().prepare('SELECT status FROM agents WHERE id = ?').get(agentId) as { status?: string } | undefined)?.status;
}

/** Is anything running: a turn, background work, a queued reply or a run unwinding. The owner's Stop asks it too. */
export function runIsLive(agentId: string): boolean {
  return statusOf(agentId) === 'working' || hasLiveWork(liveWork(agentId)) || isRunUnwinding(agentId);
}

const logger = createLogger('ended-mid-run');

function isTerminated(agentId: string): boolean {
  return statusOf(agentId) === 'terminated';
}

/** Null when the call may run; the check reads the row's status, never a name. An agent that
 *  ended itself with `complete_task` mid-turn is legitimate, so its batched calls still run. */
export function refusalForTerminated(
  tc: ToolCall, agentId: string, completedItself: boolean,
): { toolCallId: string; name: string; content: string; isError: true } | null {
  if (completedItself || !isTerminated(agentId)) return null;
  logger.warn('v2: tool call refused, this agent has been terminated', { agentId, tool: tc.name }, agentId);
  return { toolCallId: tc.id, name: tc.name, content: 'Refused: this agent has been terminated, so no tool runs.', isError: true };
}

/** Only a Stop raises the fence, so it marks ended-mid-run apart from a finished terminated agent. */
export function endedMidRun(agentId: string): boolean {
  return isStopFenced(agentId) && isTerminated(agentId);
}
