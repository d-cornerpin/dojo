// ════════════════════════════════════════════════════════════════════════════════════════
// WHEN A TASK LAST MOVED — ONE EXPRESSION, READ BY THE PM'S LADDER AND THE CLOSE-OUT GATE
// (t143 round 2, orchestrator ruling: a task's freshness may only be refreshed by activity that
// structurally names THAT task).
//
// `work.updated_at` is written only by changes to that row (a status, a claim, an edit, a
// schedule; and, since round 2, the engine checkpoint for the job's OWN tasks — see
// `engine-checkpoint-note.ts`). What it never saw is a "still working" note: `work_note` appends
// an event and touches no column. So the task's movement is the newer of its row's clock and its
// own events: its transitions, its opening and claim, the turn-finalize `activity` stamp (written
// only for turns whose trigger names the task, round 2), and anything its assignee wrote on it.
// A PM poke, the PM's own notes and engine bookkeeping are not the task moving.
//
// And WHICH work a turn names (`turnWorkIds`), which the engine checkpoint and the turn-finalize
// stamp use instead of "every claim of this agent" / "every ticket of this conversation".
// ════════════════════════════════════════════════════════════════════════════════════════

import { getDb } from '../db/connection.js';
import { taskScope } from './tracker-view.js';
import { turnContext } from '../agent/turn-context.js';

/** Epoch ms the task aliased `a` last moved. */
export const taskMovedAtSql = (a: string): string => `MAX(${a}.updated_at, COALESCE((SELECT MAX(e.created_at)
  FROM work_events e WHERE e.work_id = ${a}.id AND (e.kind IN ('transition', 'activity', 'opened', 'claim_turn')
  OR e.actor IN (${a}.agent_id, 'agent:' || ${a}.agent_id))), 0))`;

/** The job's work, handed from a park to the continuation it queues. In memory on purpose: a
 *  restart ends the job's turn, and nothing should inherit it after that.
 *  The marker is "this agent has a job parked": it is NOT a turn number, so any number of other
 *  turns (an owner's message, an A2A) may run first. It is never consumed by a turn that merely
 *  has no trigger (t143 round 4: a scheduler wake is not the continuation); it ends when the job's
 *  tasks are no longer open, or when no park has refreshed it for `CARRY_TTL_MS` (a continuation
 *  follows its park within seconds; the next park refreshes it). */
const jobWork = new Map<string, { at: number; ids: string[] }>();
const CARRY_TTL_MS = 20 * 60_000;

/** A park hands its job to the continuation it queues. Never replaces a standing job with less:
 *  a park that tied nothing leaves the carry as it was, and a park that tied work adds to it. */
export function carryJobWork(agentId: string, ids: string[], now = Date.now()): void {
  const all = [...new Set([...jobCarriedIds(agentId, now), ...ids])];
  if (all.length > 0) jobWork.set(agentId, { at: now, ids: all });
}

/** The tasks this agent's job is carrying right now: still open, and parked within the TTL. The
 *  one answer to "is this task the job in flight?" (the PM ladder and the close-out gate leave
 *  exactly these alone while the agent works them). */
export function jobCarriedIds(agentId: string, now = Date.now()): string[] {
  const carried = jobWork.get(agentId);
  if (!carried) return [];
  const open = carried.ids.length === 0 || now - carried.at > CARRY_TTL_MS ? [] : (getDb().prepare(
    `SELECT w.id AS id FROM work w WHERE w.id IN (${carried.ids.map(() => '?').join(', ')})
       AND w.state IN ('claimed', 'on_deck', 'blocked')`).all(...carried.ids) as Array<{ id: string }>).map((r) => r.id);
  if (open.length === 0) jobWork.delete(agentId);
  else if (open.length !== carried.ids.length) jobWork.set(agentId, { at: carried.at, ids: open });
  return open;
}

/** Was this task served to this turn by a tracker NOTICE (a PM re-drive, a retask, an assignment)?
 *  Being woken by one is not progress on the task (t143 round 4): only what the agent then does on
 *  it (its tool calls, notes, status changes, a delivery about it) moves it. */
export function servedByNotice(agentId: string, turnNumber: number, taskId: string | null | undefined): boolean {
  try {
    return !!taskId && !!getDb().prepare(`SELECT 1 FROM messages WHERE agent_id = ? AND served_by_turn = ?
      AND lane = 'events' AND origin_intent = 'tracker' AND task_id = ? LIMIT 1`).get(agentId, turnNumber, taskId);
  } catch { return false; /* unreadable: the served task is tied as before */ }
}

/** The tasks the CURRENT turn of this agent structurally serves (see the header above). */
export function turnWorkIds(agentId: string): string[] {
  const ctx = turnContext(agentId);
  if (!ctx || ctx.turnNumber === undefined) return [];
  const inherited = !ctx.root && !ctx.servedWork ? jobCarriedIds(agentId) : [];
  const served = ctx.servedWork?.taskId && !servedByNotice(agentId, ctx.turnNumber, ctx.servedWork.taskId) ? [ctx.servedWork.taskId] : [];
  const named = [...inherited, ...served];
  const ask = ctx.root?.kind === 'ask' ? ctx.root.sourceMessageId : null;
  const thread = ctx.root?.kind === 'a2a' ? ctx.root.id : null;
  const list = named.length > 0 ? named.map(() => '?').join(', ') : 'NULL';
  const rows = getDb().prepare(`SELECT w.id AS id FROM work w WHERE ${taskScope('w')} AND w.agent_id = ? AND (
      w.id IN (${list}) OR w.source_message_id = ? OR w.a2a_thread_id = ? OR w.origin_turn = ?
      OR w.parent_id IN (SELECT p.id FROM work p WHERE p.id IN (${list}) OR p.source_message_id = ?))`)
    .all(agentId, ...named, ask, thread, ctx.turnNumber, ...named, ask) as Array<{ id: string }>;
  return rows.map((r) => r.id);
}

