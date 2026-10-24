// The agent's claimed (in-progress) tracker tasks: the ONE query behind "your one obvious task" —
// `trackerCompleteStep` completes it when no task_id is given, and the work verbs' door re-reads
// that same task's measure before the close (`agent/tools/cat/measure-door.ts`). One query, so the
// reading always lands on the row the close judges.
import { getDb } from '../db/connection.js';
import { taskScope } from '../work/tracker-view.js';

export function claimedTasksOf(agentId: string): Array<{ id: string; title: string }> {
  return getDb().prepare(
    `SELECT w.id AS id, w.title AS title FROM work w WHERE ${taskScope('w')} AND w.agent_id = ? AND w.state = 'claimed'`,
  ).all(agentId) as Array<{ id: string; title: string }>;
}
