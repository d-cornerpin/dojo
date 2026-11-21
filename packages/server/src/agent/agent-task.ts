// The task a spawned agent owns: its explicit link when it works that task, else its one open or working task.
// Several candidates resolve nothing: refusing to guess is the point.
import { getDb } from '../db/connection.js';
import { taskScope } from '../work/tracker-view.js';
import { workingExpr } from '../work/done/hold.js';
import { workerOf } from '../work/done/record.js';

/** Every open or working task the agent owns, held ones included. */
export function ownedOpenTasks(agentId: string): Array<{ id: string; title: string }> {
  return getDb().prepare(`
    SELECT w.id AS id, w.title AS title FROM work w
     WHERE ${taskScope('w')} AND w.agent_id = ? AND ${workingExpr('w', true)}
  `).all(agentId) as Array<{ id: string; title: string }>;
}

export function resolveAgentTaskId(agentId: string, link?: string | null): string | null {
  const linked = link !== undefined ? link
    : ((getDb().prepare('SELECT task_id FROM agents WHERE id = ?').get(agentId) as { task_id: string | null } | undefined)?.task_id ?? null);
  if (linked && workerOf(linked) === agentId) return linked;   // a kept helper's link is its holder's task, not its job
  const candidates = ownedOpenTasks(agentId);
  return candidates.length === 1 ? candidates[0].id : null;
}
