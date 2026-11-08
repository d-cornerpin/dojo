// The task a spawned agent owns (moved out of `completeAgent`, v3.5): asked by `completeAgent` and
// by `complete_task`'s door, which judges that task's measure before the agent is ended.
import { getDb } from '../db/connection.js';
import { taskScope } from '../work/tracker-view.js';
import { createLogger } from '../logger.js';

const logger = createLogger('spawner');

/** The task a spawned agent owns: its explicit `task_id` link, else its ONE assigned candidate
 *  (several resolve nothing, and are logged). Asked by `completeAgent` and by `complete_task`'s door,
 *  which judges that task's measure before the agent is ended (v3.5). */
export function resolveAgentTaskId(agentId: string, link?: string | null): string | null {
  const db = getDb();
  let resolvedTaskId: string | null = link !== undefined ? link
    : ((db.prepare('SELECT task_id FROM agents WHERE id = ?').get(agentId) as { task_id: string | null } | undefined)?.task_id ?? null);
  if (!resolvedTaskId) {
    const candidates = db.prepare(`
      SELECT w.id AS id FROM work w
       WHERE ${taskScope('w')} AND w.agent_id = ?
         AND (w.state IN ('open','claimed')
              OR (w.state = 'done'
                  AND (w.completion_summary IS NULL OR w.completion_summary = '')))
    `).all(agentId) as Array<{ id: string }>;
    if (candidates.length === 1) {
      resolvedTaskId = candidates[0].id;
    } else if (candidates.length > 1) {
      logger.warn('completeAgent: no explicit task link and MULTIPLE assigned candidates; refusing to guess', {
        agentId, candidateCount: candidates.length, sample: candidates.slice(0, 3).map(c => c.id.slice(0, 8)),
      }, agentId);
    }
  }
  return resolvedTaskId;
}
