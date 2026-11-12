// Whose request a work row came from, a person's or another agent's, read off the row's own recorded
// ties (never its text) as one SQL predicate. The CASE order in `tiesSql` is the precedence;
// `work/job-origin.ts` reads the thread, message and turn ties in the same order for a job.

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

/** SQL boolean over the `work` row aliased `w`: true when another agent's request made it. Point reads only. */
export function peerOriginSql(w: string): string {
  return `(CASE WHEN ${w}.root_kind = 'a2a_thread' AND ${w}.parent_id IS NOT NULL THEN
      COALESCE((SELECT ${tiesSql(`${w}p`, `${w}p`)} FROM work ${w}p WHERE ${w}p.id = ${w}.parent_id), 0)
    ELSE ${tiesSql(w, w)} END) = 1`;
}

export function turnServesAPerson(agentId: string, turnNumber: number | null | undefined): boolean {
  if (turnNumber == null) return false;
  try {
    const row = getDb().prepare('SELECT kind FROM turns WHERE agent_id = ? AND turn_number = ?')
      .get(agentId, turnNumber) as { kind: string | null } | undefined;
    return row?.kind === 'user';
  } catch { return false; }
}

export const PEER_WORK_NOTE = 'Requests from other agents are handled in their own conversations and are not listed here.';

/** The activity report's scope: a turn serving a person leaves out peer-asked work, any other turn keeps all. */
export function activityScope(agentId: string, turnNumber: number | null | undefined): { forPerson: boolean; own: (w: string) => string } {
  const forPerson = turnServesAPerson(agentId, turnNumber);
  return { forPerson, own: (w) => (forPerson ? ` AND NOT ${peerOriginSql(w)}` : '') };
}
