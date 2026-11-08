// WHO DECIDES a handed-in task: the PM. Once the PM has been asked twice since the hand-in and gave no
// verdict, the main agent decides another agent's task and the owner decides the main agent's own. A
// task the PM worked is decided by the main agent. Never an agent that worked it (`workersOf`): when the
// next decider worked it, the owner decides.
import { getDb } from '../../db/connection.js';
import { getPMAgentId, getPrimaryAgentId } from '../../config/platform.js';
import { AUDIT_KIND } from '../audit-trail.js';
import { VALIDATION_ATTEMPT_MARKERS } from '../validation-drive.js';
import { workerOf, workersOf } from './record.js';

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
  if (!workerOf(workId)) return null;
  const worked = workersOf(workId);
  const pm = getPMAgentId();
  if (!worked.has(pm) && pmMissesSinceHandIn(workId) < PM_ASKS_BEFORE_ESCALATION) return { kind: 'agent', agentId: pm };
  const main = getPrimaryAgentId();
  return worked.has(main) ? { kind: 'owner' } : { kind: 'agent', agentId: main };
}
