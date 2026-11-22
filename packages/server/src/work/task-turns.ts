// What a turn served, read from rows written when each thing happened: `servedBy` is the one reader every check
// uses. One `claim_turn` event per (task, turn, how) records the turn on its tasks; it is not task movement.
// Known gap: a turn that works a task only through exec, files or mail is not recorded.
import type { Statement } from 'better-sqlite3';
import { getDb } from '../db/connection.js';
import { taskScope } from './tracker-view.js';
import { appendWorkEvent } from './store.js';
import { createLogger } from '../logger.js';
import { turnContext } from '../agent/turn-context.js';

const logger = createLogger('task-turns');

export type ServedHow = 'root' | 'claimed' | 'job' | 'closed' | 'shown' | 'forwarded' | 'worked' | 'opened' | 'card' | 'run';
/** One piece of work the turn served, how it served it, its row's kind and holder (null for a request's id with no row). */
export interface Served { id: string; how: ServedHow; kind: string | null; holder: string | null }
/** Every way but `shown` (the turn was only shown a request's answer) means the turn acted for the work. */
export const actedFor = (s: Served): boolean => s.how !== 'shown';
const ACTED_SQL = "s.how <> 'shown'";

// Every arm is filtered by agent and starts from an index; the agent's own rows are those open in the turn or closed since
// it began. Marks naming the turn are read from its start, the rest in its window; `focused` keeps them to `@focus`.
const servedSql = (focused: boolean): string => `
WITH t AS (SELECT agent_id, turn_number, root_kind, root_id, started_at, ended_at,
             unixepoch(started_at) * 1000 AS s_ms,
             COALESCE((SELECT unixepoch(nx.started_at) * 1000 FROM turns nx WHERE nx.agent_id = @a AND nx.turn_number = @n + 1),
                      (unixepoch(COALESCE(ended_at, datetime('now'))) + 1) * 1000) AS e_ms
           FROM turns WHERE agent_id = @a AND turn_number = @n),
mine AS (SELECT w.id, w.kind, w.root_kind, w.a2a_thread_id, w.opened_at, w.origin_turn, w.requester_id, w.source_message_id,
                w.result_delivery_id FROM work w
          WHERE ${focused ? 'w.id IN (SELECT value FROM json_each(@focus)) AND +w.agent_id' : 'w.agent_id'} = @a AND w.kind IN ('ask', 'task')
            AND (w.closed_at IS NULL OR w.closed_at >= COALESCE((SELECT s_ms FROM t), 0) - 1000)),
direct(id, how) AS (
  SELECT 'ask:' || t.root_id, 'root' FROM t WHERE t.root_kind = 'ask'
  UNION SELECT t.root_id, 'root' FROM t WHERE t.root_kind = 'occurrence'
  UNION SELECT r.parent_id, 'root' FROM t JOIN work r ON r.id = t.root_id WHERE t.root_kind = 'occurrence'
  UNION SELECT m.task_id, 'root' FROM t JOIN messages m ON m.id = t.root_id WHERE t.root_kind = 'engine' AND m.task_id IS NOT NULL
  UNION SELECT m.run_id, 'root' FROM t JOIN messages m ON m.id = t.root_id WHERE t.root_kind = 'engine' AND m.run_id IS NOT NULL
  UNION SELECT 'ask:' || m.root_id, 'root' FROM t JOIN messages m ON m.id = t.root_id WHERE t.root_kind = 'engine' AND m.root_kind = 'ask'
  UNION SELECT w.id, 'root' FROM t JOIN mine w ON w.kind = 'task' AND w.a2a_thread_id = t.root_id AND w.opened_at < t.s_ms + 1000
     WHERE t.root_kind = 'a2a'
  UNION SELECT p.parent_id, 'root' FROM t JOIN work p ON p.root_kind = 'a2a_thread' AND p.root_id = t.root_id AND p.agent_id = @a
     AND p.parent_id IS NOT NULL AND p.opened_at < t.s_ms + 1000 WHERE t.root_kind = 'a2a'
  UNION SELECT p.id, 'root' FROM t JOIN work p ON p.root_kind = 'a2a_thread' AND p.root_id = t.root_id AND p.assignee_agent = @a
     AND p.opened_at < t.e_ms WHERE t.root_kind = 'a2a'
  UNION SELECT e.work_id, COALESCE(json_extract(e.payload, '$.how'), 'claimed') FROM t, mine w
     JOIN work_events e ON e.work_id = w.id AND e.kind = 'claim_turn' AND e.created_at >= t.s_ms - 1000
     WHERE json_extract(e.payload, '$.turn_number') = @n AND (w.kind = 'ask'
       OR (json_extract(e.payload, '$.how') = 'job' AND json_extract(e.payload, '$.agent_id') = @a))
  UNION SELECT w.id, 'closed' FROM mine w WHERE w.kind = 'ask'
     AND w.result_delivery_id IN (SELECT d.id FROM deliveries d WHERE d.agent_id = @a AND d.turn_number = @n)
  UNION SELECT e.work_id, 'shown' FROM t, mine w JOIN work_events e ON e.work_id = w.id AND e.kind = 'audit'
     AND e.created_at >= t.s_ms
     WHERE w.kind = 'ask' AND json_extract(e.payload, '$.marker') = 'pieces_shown' AND json_extract(e.payload, '$.turn') = @n
  UNION SELECT p.parent_id, 'forwarded' FROM deliveries d JOIN messages m ON m.id = d.message_id
     JOIN work p ON p.root_kind = 'a2a_thread' AND p.root_id = m.a2a_thread_id AND p.agent_id = @a AND p.parent_id IS NOT NULL
      AND p.opened_at < unixepoch(d.created_at) * 1000 + 1000 AND (p.closed_at IS NULL OR p.closed_at >= unixepoch(d.created_at) * 1000)
     WHERE d.agent_id = @a AND d.turn_number = @n AND d.tool = 'send_to_agent'
  UNION SELECT w.id, 'worked' FROM t, mine w JOIN work_events e ON e.work_id = w.id AND e.kind IN ('transition', 'activity')
      AND e.actor IN (@a, 'agent:' || @a) AND e.created_at >= t.s_ms AND e.created_at < t.e_ms
     WHERE w.kind = 'task' AND w.root_kind <> 'a2a_thread'
  UNION SELECT w.id, 'opened' FROM mine w WHERE w.origin_turn = @n AND w.kind = 'task' AND w.root_kind <> 'a2a_thread' AND w.requester_id = @a
),
served(id, how) AS (
  SELECT id, how FROM direct WHERE id IS NOT NULL
  UNION SELECT c.id, 'card' FROM mine c CROSS JOIN direct s ON c.kind = 'task' AND c.root_kind <> 'a2a_thread' AND c.requester_id = @a
    AND c.source_message_id = substr(s.id, 5) WHERE s.id LIKE 'ask:%' AND ${ACTED_SQL}
  UNION SELECT o.id, 'run' FROM direct s CROSS JOIN work o ON o.kind = 'occurrence' AND o.parent_id = s.id, t
    WHERE ${ACTED_SQL} AND o.opened_at < t.e_ms AND (o.closed_at IS NULL OR o.closed_at >= t.s_ms)
)
SELECT s.id, s.how, CASE WHEN w.root_kind = 'a2a_thread' THEN 'piece' ELSE w.kind END AS kind, COALESCE(w.assignee_agent, w.agent_id) AS holder
  FROM served s LEFT JOIN work w ON w.id = s.id ORDER BY s.how = 'root' DESC, s.id, s.how`;

/** Everything turn `turnNumber` of `agentId` served, with how; with `focus`, only what touches those rows of the agent. */
export function servedBy(agentId: string, turnNumber: number, focus?: readonly string[]): Served[] {
  const db = getDb();
  const both = prepared.get(db) ?? { whole: db.prepare(servedSql(false)), focused: db.prepare(servedSql(true)) };
  prepared.set(db, both);
  return (focus ? both.focused.all({ a: agentId, n: turnNumber, focus: JSON.stringify(focus) }) : both.whole.all({ a: agentId, n: turnNumber })) as Served[];
}
const prepared = new WeakMap<object, { whole: Statement; focused: Statement }>();

/** The requests (ask ids) the turn took up: its root and the ones it claimed. */
export const takenUp = (served: readonly Served[]): string[] =>
  [...new Set(served.filter((s) => s.id.startsWith('ask:') && (s.how === 'root' || s.how === 'claimed')).map((s) => s.id))];
export const requestsTakenUpBy = (agentId: string, turnNumber: number): string[] => takenUp(servedBy(agentId, turnNumber));

/** The tasks the turn (by default the running one) served that the agent holds, the turn's root first. */
export function tasksServedBy(agentId: string, turnNumber = turnContext(agentId)?.turnNumber): string[] {
  if (turnNumber === undefined) return [];
  return [...new Set(servedBy(agentId, turnNumber).filter((s) => s.kind === 'task' && s.holder === agentId).map((s) => s.id))];
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
  for (const id of [...new Set(served)]) {
    const mine = db.prepare(`SELECT 1 FROM work w WHERE w.id = ? AND ${taskScope('w')} AND COALESCE(w.assignee_agent, w.agent_id) = ?`).get(id, agentId);
    if (!mine) continue;
    const seen = db.prepare(`SELECT 1 FROM work_events WHERE work_id = ? AND kind = 'claim_turn' AND json_extract(payload, '$.turn_number') = ?
      AND json_extract(payload, '$.how') IS NULL LIMIT 1`).get(id, turnNumber);
    if (seen) continue;
    appendWorkEvent(id, 'claim_turn', 'engine', { turn_number: turnNumber });
    written.push(id);
  }
}
