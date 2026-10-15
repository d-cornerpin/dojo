// ════════════════════════════════════════════════════════════════════════════════════════
// t174 — WHOSE REQUEST A WORK ROW CAME FROM: a person's, or another agent's.
//
// The owner, 2026-10-15: "Leave it out of my answers." Asked what the agent had finished for him, it
// listed a peer agent's mail search as his. The activity report read every row on the board. When the
// turn serves a person, the report is that person's work; work another agent asked for is handled in
// that agent's own conversation and is not his to be told about.
//
// THE ORIGIN IS READ OFF THE ROW'S OWN RECORDED TIES, never off its text — the same ties
// `work/job-origin.ts` (t173) reads for a job, in the same order, as one SQL predicate so a report can
// count with it:
//   1. `a2a_thread_id` / `origin_kind = 'a2a_assign'`: the task the engine opens for an ASSIGN;
//   2. `conversation_id`: a person's conversation;
//      (a commitment made on a turn serving a thread is rooted at that thread);
//   3. the message the row answers (`source_message_id`, or the root of an ask / commitment): an A2A
//      message names a thread, a person's message does not;
//   4. a join piece (`root_kind = 'a2a_thread'`) is its PARENT's work, not the thread's: the owner's ask
//      delegated to a helper is still the owner's;
//   5. `origin_turn` (a commitment's `turn:<n>` root): a turn whose rows are stamped with a thread.
// A row with none of these is nobody's peer request (a schedule's occurrence, a person's ask).
// ════════════════════════════════════════════════════════════════════════════════════════

import { getDb } from '../db/connection.js';

/** The row's own origin ties, without the parent step (a piece's parent is itself never a piece). */
function tiesSql(w: string, k: string): string {
  const src = `COALESCE(${w}.source_message_id, CASE WHEN ${w}.kind IN ('ask','commitment') AND ${w}.root_id NOT LIKE 'turn:%' THEN ${w}.root_id END)`;
  const turn = `COALESCE(${w}.origin_turn, CASE WHEN ${w}.root_id LIKE 'turn:%' THEN CAST(substr(${w}.root_id, 6) AS INTEGER) END)`;
  return `CASE
    WHEN ${w}.a2a_thread_id IS NOT NULL OR ${w}.origin_kind = 'a2a_assign' THEN 1
    WHEN ${w}.conversation_id IS NOT NULL THEN 0
    WHEN ${w}.kind = 'commitment' AND EXISTS (SELECT 1 FROM messages ${k}c WHERE ${k}c.agent_id = ${w}.agent_id
           AND ${k}c.a2a_thread_id = ${w}.root_id) THEN 1
    WHEN EXISTS (SELECT 1 FROM messages ${k}s WHERE ${k}s.id = ${src}) THEN
      EXISTS (SELECT 1 FROM messages ${k}s WHERE ${k}s.id = ${src} AND ${k}s.a2a_thread_id IS NOT NULL)
    WHEN ${turn} IS NOT NULL THEN
      EXISTS (SELECT 1 FROM messages ${k}t WHERE ${k}t.agent_id = ${w}.agent_id AND ${k}t.turn_number = ${turn}
                AND ${k}t.a2a_thread_id IS NOT NULL)
    ELSE 0 END`;
}

/**
 * A SQL boolean over the `work` row aliased `w`: true when the row came from another agent's request.
 * Use as `AND NOT (${peerOriginSql('w')})`. Point reads only: the `messages` primary key and
 * `(agent_id, turn_number)`.
 */
export function peerOriginSql(w: string): string {
  return `(CASE WHEN ${w}.root_kind = 'a2a_thread' AND ${w}.parent_id IS NOT NULL THEN
      COALESCE((SELECT ${tiesSql(`${w}p`, `${w}p`)} FROM work ${w}p WHERE ${w}p.id = ${w}.parent_id), 0)
    ELSE ${tiesSql(w, w)} END) = 1`;
}

/** Is this turn serving a person? Read off the turn's own record (`kind = 'user'`); a turn serving another
 *  agent, an engine event, or nothing recorded keeps the full report. */
export function turnServesAPerson(agentId: string, turnNumber: number | null | undefined): boolean {
  if (turnNumber == null) return false;
  try {
    const row = getDb().prepare('SELECT kind FROM turns WHERE agent_id = ? AND turn_number = ?')
      .get(agentId, turnNumber) as { kind: string | null } | undefined;
    return row?.kind === 'user';
  } catch { return false; }
}

/** t174: said once, on a report that left another agent's requests out. */
export const PEER_WORK_NOTE = 'Requests from other agents are handled in their own conversations and are not listed here.';

/** The scope of the activity report for the turn in flight: a turn serving a person reports that person's work and
 *  leaves out work another agent asked for (`own(alias)` is the SQL to append); any other turn keeps the whole board. */
export function activityScope(agentId: string, turnNumber: number | null | undefined): { forPerson: boolean; own: (w: string) => string } {
  const forPerson = turnServesAPerson(agentId, turnNumber);
  return { forPerson, own: (w) => (forPerson ? ` AND NOT ${peerOriginSql(w)}` : '') };
}
