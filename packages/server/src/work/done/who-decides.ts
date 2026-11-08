// WHO DECIDES a handed-in task: the PM. Once the PM has been asked twice since the hand-in and gave no
// verdict, the main agent decides another agent's task and the owner decides the main agent's own. A
// task the PM works is another agent's task to the PM, so the main agent decides it. Never the worker:
// when the next decider would be the worker, the owner decides.
import { getDb } from '../../db/connection.js';
import { getPMAgentId, getPrimaryAgentId } from '../../config/platform.js';
import { AUDIT_KIND } from '../audit-trail.js';
import { VALIDATION_ATTEMPT_MARKERS } from '../validation-drive.js';
import { workerOf } from './hand-in.js';

export type Decider = { kind: 'agent'; agentId: string } | { kind: 'owner' };

/** How many PM asks past the hand-in hand the decision on. */
export const PM_ASKS_BEFORE_ESCALATION = 2;

/** The PM's unanswered asks about this row since its newest hand-in. */
function pmMissesSinceHandIn(workId: string): number {
  const markers = VALIDATION_ATTEMPT_MARKERS.map((m) => `'${m}'`).join(', ');
  return (getDb().prepare(
    `SELECT COUNT(*) AS n FROM work_events e
      WHERE e.work_id = ? AND e.kind = '${AUDIT_KIND}' AND json_extract(e.payload, '$.action_taken') IN (${markers})
        AND e.id > COALESCE((SELECT MAX(h.id) FROM work_events h WHERE h.work_id = e.work_id AND h.kind = 'handed_in'), 0)`,
  ).get(workId) as { n: number }).n;
}

/** The decider for this row now; null when there is no such row. */
export function whoDecides(workId: string): Decider | null {
  const worker = workerOf(workId);
  if (!worker) return null;
  const pm = getPMAgentId();
  if (worker !== pm && pmMissesSinceHandIn(workId) < PM_ASKS_BEFORE_ESCALATION) return { kind: 'agent', agentId: pm };
  const main = getPrimaryAgentId();
  return worker === main ? { kind: 'owner' } : { kind: 'agent', agentId: main };
}
