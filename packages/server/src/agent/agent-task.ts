// The task a spawned agent owns: its explicit link, else its one assigned candidate.
// Several candidates resolve nothing and are logged: refusing to guess is the point.
import { getDb } from '../db/connection.js';
import { taskScope } from '../work/tracker-view.js';
import { createLogger } from '../logger.js';
import { workingExpr } from '../work/done/hold.js';

const logger = createLogger('spawner');

export function resolveAgentTaskId(agentId: string, link?: string | null): string | null {
  const db = getDb();
  let resolvedTaskId: string | null = link !== undefined ? link
    : ((db.prepare('SELECT task_id FROM agents WHERE id = ?').get(agentId) as { task_id: string | null } | undefined)?.task_id ?? null);
  if (!resolvedTaskId) {
    const candidates = db.prepare(`
      SELECT w.id AS id FROM work w
       WHERE ${taskScope('w')} AND w.agent_id = ?
         AND ${workingExpr('w', true)}
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
