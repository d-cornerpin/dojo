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
 *  The marker is "this agent has a job parked and its continuation has not run yet" — it is NOT a
 *  turn number: any number of other turns (an owner's message, an A2A) may run first, and only a
 *  turn with no trigger of its own (the self-wake) picks it up (t143 round 3, C1). */
const jobWork = new Map<string, { parkedTurn: number; ids: string[] }>();

/** A park hands its job to the continuation it queues. Never replaces a standing job with less:
 *  a park that tied nothing leaves the carry as it was, and a park that tied work adds to it. */
export function carryJobWork(agentId: string, parkedTurn: number, ids: string[]): void {
  const standing = jobWork.get(agentId)?.ids ?? [];
  const all = [...new Set([...standing, ...ids])];
  if (all.length > 0) jobWork.set(agentId, { parkedTurn, ids: all });
}

/** Called when a turn finalizes: a continuation (no trigger of its own) that did not park again
 *  ends the job's carry. A turn with its own trigger leaves it standing for the continuation. */
export function settleJobWork(agentId: string): void {
  const ctx = turnContext(agentId);
  const carried = jobWork.get(agentId);
  if (!ctx || !carried || ctx.root || ctx.servedWork) return;
  if (carried.parkedTurn !== ctx.turnNumber) jobWork.delete(agentId);
}

/** The tasks the CURRENT turn of this agent structurally serves (see the header above). */
export function turnWorkIds(agentId: string): string[] {
  const ctx = turnContext(agentId);
  if (!ctx || ctx.turnNumber === undefined) return [];
  const carried = jobWork.get(agentId);
  const inherited = !ctx.root && !ctx.servedWork && carried ? carried.ids : [];
  const named = [...inherited, ...(ctx.servedWork?.taskId ? [ctx.servedWork.taskId] : [])];
  const ask = ctx.root?.kind === 'ask' ? ctx.root.sourceMessageId : null;
  const thread = ctx.root?.kind === 'a2a' ? ctx.root.id : null;
  const list = named.length > 0 ? named.map(() => '?').join(', ') : 'NULL';
  const rows = getDb().prepare(`SELECT w.id AS id FROM work w WHERE ${taskScope('w')} AND w.agent_id = ? AND (
      w.id IN (${list}) OR w.source_message_id = ? OR w.a2a_thread_id = ? OR w.origin_turn = ?
      OR w.parent_id IN (SELECT p.id FROM work p WHERE p.id IN (${list}) OR p.source_message_id = ?))`)
    .all(agentId, ...named, ask, thread, ctx.turnNumber, ...named, ask) as Array<{ id: string }>;
  return rows.map((r) => r.id);
}

