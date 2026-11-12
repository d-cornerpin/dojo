// One `claim_turn` event per (task, turn), written at the turn's end by `tracker/task-stamps.ts`: the tasks
// the turn served plus those the agent moved. Held by `assignee_agent`, else `agent_id`. Not task movement.
// Known gap: a turn that works a task only through exec, files or mail is not recorded.
import { getDb } from '../db/connection.js';
import { taskScope } from './tracker-view.js';
import { appendWorkEvent } from './store.js';
import { createLogger } from '../logger.js';

const logger = createLogger('task-turns');

/** Tasks the agent holds that it moved or noted under its own name since this turn started. */
function movedByTheTurn(agentId: string, turnNumber: number): string[] {
  return (getDb().prepare(
    `SELECT DISTINCT w.id AS id FROM work w
       JOIN work_events e ON e.work_id = w.id AND e.kind IN ('transition', 'activity') AND e.actor IN (?, 'agent:' || ?)
       JOIN turns t ON t.agent_id = ? AND t.turn_number = ?
      WHERE ${taskScope('w')} AND COALESCE(w.assignee_agent, w.agent_id) = ?
        AND e.created_at >= CAST(strftime('%s', t.started_at) AS INTEGER) * 1000`,
  ).all(agentId, agentId, agentId, turnNumber, agentId) as Array<{ id: string }>).map((r) => r.id);
}

/** Record this turn on every task it worked, once per task and turn; returns the ids written. A failure is
 *  logged and never stops the stamps beside it. */
export function recordTurnOnTasks(agentId: string, turnNumber: number, served: string[]): string[] {
  const written: string[] = [];
  try { write(agentId, turnNumber, served, written); } catch (err) {
    logger.warn('recording the turn on its tasks failed (non-fatal)', { agentId, turnNumber, error: err instanceof Error ? err.message : String(err) }, agentId);
  }
  return written;
}

function write(agentId: string, turnNumber: number, served: string[], written: string[]): void {
  const db = getDb();
  const ids = [...new Set([...served, ...movedByTheTurn(agentId, turnNumber)])];
  for (const id of ids) {
    const mine = db.prepare(`SELECT 1 FROM work w WHERE w.id = ? AND ${taskScope('w')} AND COALESCE(w.assignee_agent, w.agent_id) = ?`).get(id, agentId);
    if (!mine) continue;
    const seen = db.prepare(
      `SELECT 1 FROM work_events WHERE work_id = ? AND kind = 'claim_turn' AND json_extract(payload, '$.turn_number') = ? LIMIT 1`,
    ).get(id, turnNumber);
    if (seen) continue;
    appendWorkEvent(id, 'claim_turn', 'engine', { turn_number: turnNumber });
    written.push(id);
  }
}
