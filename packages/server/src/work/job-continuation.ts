import { createLogger } from '../logger.js';
import { isStopFenced } from '../agent/shared-state.js';
import { turnContext } from '../agent/turn-context.js';
import { serveLater } from '../agent/v2/serve-later.js';
import { openEngineScaffoldTask } from '../agent/v2/steps/execute/tracker-floors.js';
import { linkedTaskOf } from './ask-settlement.js';
import { turnWorkIds } from './task-freshness.js';
import { PARKED_JOB_TITLE } from './tracker-view.js';

const logger = createLogger('job-continuation');

/** ONE task carries the turn's work: the one the turn was started from, else the one linked to its request, else the
 *  first the turn worked. */
export const jobOfTurn = (agentId: string, request: string | null): string | null =>
  turnContext(agentId)?.servedJob ?? linkedTaskOf(agentId, request) ?? turnWorkIds(agentId)[0] ?? null;

/** THE ONE DEFINITION OF "PARK": the job's task gets its due time; with no task, a turn serving a request opens the
 *  engine task first. A park with no task and no request continues nothing, and a stopped run parks nothing. */
export function parkJob(agentId: string, reason: string, due: number | 'event', after?: Promise<unknown>): boolean {
  const bag = turnContext(agentId);
  if (isStopFenced(agentId)) return false;
  // The request this turn serves: a person's message, or another agent's request.
  const request = bag?.root?.kind === 'ask' ? bag.root.sourceMessageId : bag?.servedRequest?.messageId ?? null;
  const job = jobOfTurn(agentId, request)
    ?? (request && bag?.turnNumber !== undefined
      ? openEngineScaffoldTask(agentId, PARKED_JOB_TITLE, bag.turnNumber, { messageId: request, convKey: bag.convKey ?? null, threadId: bag.servedRequest?.threadId })
      : null);
  if (!job) { logger.info('park: no task and no request, nothing continues', { agentId, reason }, agentId); return false; }
  serveLater({ kind: 'task', id: job }, due === 'event' ? Date.now() + 15 * 60_000 : due, reason);
  const arrived = (): void => serveLater({ kind: 'task', id: job }, Date.now(), `${reason}: the event arrived`, { onlyIfParked: true });
  if (after) void after.then(arrived, arrived);
  if (bag) bag.jobParked = job;
  return true;
}
