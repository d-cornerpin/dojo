// ════════════════════════════════════════
// WHICH TURNS WORKED A TASK — one `claim_turn` event per (task, turn), written at the turn's end.
//
// `claim_turn` on an ASK row is the pickup record (`stampClaimingTurn`: the turn that claimed the
// owner's message). A TASK is never claimed that way: an assignee comes to it by an assignment or
// retask notice, by a continuation park carrying its job, or by taking it up itself with work_update,
// and a task is worked across many turns. So the timeline's task scope ("everything its assignee did
// in the turns that claimed it", `inspect/timeline.ts`) and the last-turn-end read (`lastTurnEnd`)
// found nothing on a task, in practice, ever.
//
// The one honest writer is the turn's own end (`tracker/task-stamps.ts`, the ticket-stamp point,
// which already decides which tasks the ending turn served). At that point the engine knows:
//   - the tasks the turn structurally serves (`turnWorkIds`: the job it carries, the task it was
//     served, the tasks it created or answered for), less a task it was only WOKEN about by a notice
//     (being woken is not working it); and
//   - the tasks the agent itself moved during the turn (a transition or an activity note written
//     under its name since the turn started: picking a task up, noting progress, closing it).
// Each is recorded once against the task with the same payload the ask pickup writes.
//
// "Held by" is the row's holder as every reader of these turn numbers reads it: `assignee_agent` when
// set, else `agent_id` (`COALESCE`, as the timeline and the friction census join), so after a hand-off
// the turn numbers are the new assignee's own.
//
// KNOWN GAP, stated in the timeline's note: a turn that works the task only through exec, files or
// mail, while neither serving it nor touching it in the tracker, is not recorded.
//
// Nothing here touches the task's last-moved time: the event is not movement (`taskMovedAtSql`).
// ════════════════════════════════════════
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

/** Record this turn against every task it worked (once per task and turn). Returns the task ids written.
 *  Best-effort at the turn's end: a failure is logged and never stops the stamps beside it. */
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
