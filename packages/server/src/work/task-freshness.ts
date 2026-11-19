// When a task last moved: one expression, read by the PM's ladder and the close-out gate. Only activity that
// structurally names THAT task refreshes it. Plain assignee notes, PM pokes and engine bookkeeping are not
// movement; a status, an edit, a delivery or the turn's `activity` stamp is.

import { getDb } from '../db/connection.js';
import { taskScope } from './tracker-view.js';
import { turnContext } from '../agent/turn-context.js';

/** Epoch ms the task aliased `a` last moved. `claim_turn` is not movement (`work/task-turns.ts`); a ledger
 *  item its calls touched (`work/ledger-store.ts`) is, so a job working through a set never looks idle. */
export const taskMovedAtSql = (a: string): string => `MAX(${a}.updated_at,
  COALESCE((SELECT MAX(l.last_at) FROM work_ledger l WHERE l.work_id = ${a}.id), 0), COALESCE((SELECT MAX(e.created_at)
  FROM work_events e WHERE e.work_id = ${a}.id AND ((e.kind IN ('transition', 'activity', 'opened') AND e.actor <> 'migration-901')
  OR (e.actor IN (${a}.agent_id, 'agent:' || ${a}.agent_id)
      AND NOT (e.kind = 'audit' AND json_extract(e.payload, '$.entry_kind') = 'observation')))), 0))`;

export const LADDER_ANCHOR_SQL = `COALESCE((SELECT unixepoch(applied_at) * 1000 FROM _migrations WHERE name LIKE '901%'), 0)`;

/** SQL: when the row under alias `a` began to stall: last move, latest hold lift, or the ladder anchor. */
export const stallSinceSql = (a: string): string => `MAX(${taskMovedAtSql(a)}, ${LADDER_ANCHOR_SQL}, COALESCE((SELECT MAX(c.created_at)
  FROM work_events c WHERE c.work_id = ${a}.id AND c.kind = 'audit' AND json_extract(c.payload, '$.entry_kind') = 'hold_cleared'), 0))`;

/** Was this task served to this turn by a tracker notice (re-drive, retask, assignment)? Being woken by one
 *  is not progress: only what the agent then does on the task moves it. */
export function servedByNotice(agentId: string, turnNumber: number, taskId: string | null | undefined): boolean {
  try {
    return !!taskId && !!getDb().prepare(`SELECT 1 FROM messages WHERE agent_id = ? AND served_by_turn = ?
      AND lane = 'events' AND origin_intent = 'tracker' AND task_id = ? LIMIT 1`).get(agentId, turnNumber, taskId);
  } catch { return false; /* unreadable: the served task is tied as before */ }
}

export function turnWorkIds(agentId: string): string[] {
  const ctx = turnContext(agentId);
  if (!ctx || ctx.turnNumber === undefined) return [];
  const named = ctx.servedWork?.taskId ? [ctx.servedWork.taskId] : [];   // the served task IS the job, whatever woke the turn
  const ask = ctx.root?.kind === 'ask' ? ctx.root.sourceMessageId : null;
  const thread = ctx.root?.kind === 'a2a' ? ctx.root.id : null;
  const list = named.length > 0 ? named.map(() => '?').join(', ') : 'NULL';
  const rows = getDb().prepare(`SELECT w.id AS id FROM work w WHERE ${taskScope('w')} AND w.agent_id = ? AND (
      w.id IN (${list}) OR w.source_message_id = ? OR w.a2a_thread_id = ? OR w.origin_turn = ?
      OR w.parent_id IN (SELECT p.id FROM work p WHERE p.id IN (${list}) OR p.source_message_id = ?))`)
    .all(agentId, ...named, ask, thread, ctx.turnNumber, ...named, ask) as Array<{ id: string }>;
  return rows.map((r) => r.id);
}

