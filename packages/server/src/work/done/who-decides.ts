// WHO DECIDES a handed-in task: the PM, until two verdictless reviews or three send-backs; then the main agent
// (another agent's task) or the owner (the main agent's own). A task the PM worked starts with the main agent.
// Never a worker of the task (`workersOf`): then the owner.
import { getDb } from '../../db/connection.js';
import { getPMAgentId, getPrimaryAgentId } from '../../config/platform.js';
import { AUDIT_KIND } from '../audit-trail.js';
import { workerOf, workersOf } from './record.js';

export type Decider = { kind: 'agent'; agentId: string } | { kind: 'owner' };

const PM_ASKS_BEFORE_ESCALATION = 2;
export const SEND_BACKS_BEFORE_ESCALATION = 3;
export const REVIEW_MISS_ENTRY = 'review_miss';

/** The PM's reviews of this row since its newest hand-in that gave no verdict. */
function pmMissesSinceHandIn(workId: string): number {
  return (getDb().prepare(
    `SELECT COUNT(*) AS n FROM work_events e
      WHERE e.work_id = ? AND e.kind = '${AUDIT_KIND}' AND json_extract(e.payload, '$.entry_kind') = '${REVIEW_MISS_ENTRY}'
        AND e.id > COALESCE((SELECT MAX(h.id) FROM work_events h WHERE h.work_id = e.work_id AND h.kind = 'handed_in'), 0)`,
  ).get(workId) as { n: number }).n;
}

/** Every send-back on this row, oldest first: its reason and when. */
export function sendBacks(workId: string): Array<{ reason: string; at: number }> {
  return (getDb().prepare(
    `SELECT COALESCE(json_extract(payload, '$.reason'), '') AS reason, created_at AS at FROM work_events
      WHERE work_id = ? AND kind = 'decided' AND json_extract(payload, '$.verdict') = 'send_back' ORDER BY id`,
  ).all(workId) as Array<{ reason: string; at: number }>);
}

/** The decider for this row now; null when there is no such row. */
export function whoDecides(workId: string): Decider | null {
  if (!workerOf(workId)) return null;
  const worked = workersOf(workId);
  const pm = getPMAgentId();
  const pmStill = pmMissesSinceHandIn(workId) < PM_ASKS_BEFORE_ESCALATION && sendBacks(workId).length < SEND_BACKS_BEFORE_ESCALATION;
  if (!worked.has(pm) && pmStill) return { kind: 'agent', agentId: pm };
  const main = getPrimaryAgentId();
  return worked.has(main) ? { kind: 'owner' } : { kind: 'agent', agentId: main };
}
