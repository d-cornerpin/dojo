// A PROJECT IS ITS TASKS. Its state is derived, never judged: with no tasks its stored state stands; any
// task still open or closed as couldn't-be-done keeps it working; all done or cancelled with at least one
// done makes it done, on its newest done task's delivery; all cancelled makes it cancelled.
import { getDb } from '../../db/connection.js';
import { createLogger } from '../../logger.js';
import { transition, isTerminal, type WorkState } from '../store.js';
import { taskScope } from '../tracker-view.js';
import { deliveryForCompletedChildren } from '../tracker-store.js';
import { recordDecisionReceipt, deliveryIdOf } from '../../agent/v2/deliveries.js';
import { unitOrRollback, recordAdjudication } from './record.js';

const logger = createLogger('project-state');

/** The project's derived state: 'done', 'abandoned', 'working', or null when it has no tasks. */
export function deriveProjectState(projectId: string): 'done' | 'abandoned' | 'working' | null {
  const c = getDb().prepare(
    `SELECT COUNT(*) AS n, SUM(w.state = 'done') AS done, SUM(w.state = 'abandoned') AS cancelled FROM work w
      WHERE w.parent_id = ? AND ${taskScope('w')}`,
  ).get(projectId) as { n: number; done: number | null; cancelled: number | null };
  if (c.n === 0) return null;
  if ((c.done ?? 0) + (c.cancelled ?? 0) < c.n) return 'working';
  return (c.done ?? 0) > 0 ? 'done' : 'abandoned';
}

/** Move a still-open project to its derived end, if its tasks have one. True when it moved. */
export function settleProject(projectId: string): boolean {
  const derived = deriveProjectState(projectId);
  const row = getDb().prepare('SELECT state FROM work WHERE id = ?').get(projectId) as { state: WorkState } | undefined;
  if (!row || isTerminal(row.state) || (derived !== 'done' && derived !== 'abandoned')) return false;
  const r = unitOrRollback(() => {
    const evidence = derived === 'done' ? deliveryForCompletedChildren(projectId)
      : deliveryIdOf(recordDecisionReceipt(projectId, 'The engine', 'every task of the project being cancelled'));
    if (derived === 'done') recordAdjudication(projectId, 'done', 'engine', evidence, 'derived from its tasks');
    return transition(projectId, {
      to: derived, by: 'engine', actorId: 'engine', claim: 'decided', reason: 'every task of the project has ended',
      evidenceRef: evidence, resultDeliveryId: derived === 'done' ? evidence : null,
    });
  });
  if (r.kind !== 'applied') logger.warn('project did not settle on its tasks', { projectId, derived, outcome: r });
  return r.kind === 'applied';
}
