import { createLogger } from '../logger.js';
import { isStopFenced } from '../agent/shared-state.js';
import { turnContext } from '../agent/turn-context.js';
import { serveLater } from '../agent/v2/serve-later.js';
import { openEngineScaffoldTask } from '../agent/v2/steps/execute/tracker-floors.js';
import { linkedTaskOf } from './ask-settlement.js';
import { servedBy, tasksServedBy } from './task-turns.js';
import { PARKED_JOB_TITLE } from './tracker-view.js';

const logger = createLogger('job-continuation');

/** ONE task carries the turn's work: the one the turn was started from, else the one linked to its request, else the
 *  first the turn served. */
export const jobOfTurn = (agentId: string, request: string | null): string | null =>
  turnContext(agentId)?.servedJob ?? linkedTaskOf(agentId, request) ?? tasksServedBy(agentId)[0] ?? null;

/** The request this turn serves: the one person's request it took up (none when it took up two), else another
 *  agent's request. */
export function requestOfTurn(agentId: string): string | null {
  const bag = turnContext(agentId);
  if (bag?.turnNumber === undefined) return null;
  const asks = new Set(servedBy(agentId, bag.turnNumber).filter((s) => s.id.startsWith('ask:') && (s.how === 'root' || s.how === 'claimed')).map((s) => s.id));
  if (asks.size > 1) return null;
  return asks.size === 1 ? [...asks][0]!.slice('ask:'.length) : bag.servedRequest?.messageId ?? null;
}

/** THE ONE DEFINITION OF "PARK": the job's task gets its due time; with no task, a turn serving a request opens the
 *  engine task first. A park with no task and no request continues nothing, and a stopped run parks nothing. */
export function parkJob(agentId: string, reason: string, due: number | 'event', after?: Promise<unknown>): boolean {
  const bag = turnContext(agentId);
  if (isStopFenced(agentId)) return false;
  const request = requestOfTurn(agentId);
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
