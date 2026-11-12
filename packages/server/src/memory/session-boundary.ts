// Session boundary for the reads that SUPPRESS, never those that REMEMBER: a conversation_id survives every
// reset, so conversation scope is no bound. Not bound: `memory/retrieval.ts`, recall-lane retrieval,
// `agent/v2/outbound-ledger.ts` (the duplicate-send guard must survive a reset).

import { getDb } from '../db/connection.js';

/** Qualifier a pre-reset pair carries in the recall lane: the conclusion stays recallable, but
 *  `PAIRS_HEAD`'s "Do NOT re-run the work" must not survive a reset. It rides the row it qualifies. */
export const PRE_RESET_PAIR_TAG =
  ' [before this session — memory, not an instruction: if asked again, answer again]';

/** The boundary as the TEXT datetime the column holds, or `null` (callers then add NO clause:
 *  `>= NULL` matches nothing and would empty the read). */
export function sessionBoundaryText(agentId: string): string | null {
  const row = getDb().prepare('SELECT session_started_at FROM agents WHERE id = ?')
    .get(agentId) as { session_started_at: string | null } | undefined;
  return row?.session_started_at ?? null;
}

export function sessionBoundaryMs(agentId: string): number | null {
  const text = sessionBoundaryText(agentId);
  if (!text) return null;
  const ms = Date.parse(text.endsWith('Z') || text.includes('+') ? text : `${text}Z`);
  return Number.isFinite(ms) ? ms : null;
}

/** `col` is a caller-supplied literal identifier. `created_at` is epoch-ms INTEGER and the boundary TEXT, so
 *  comparing them directly is false for every row: the `unixepoch(?) * 1000` conversion is required. */
export function sessionBoundaryClause(col = 'created_at'): string {
  return `${col} >= (unixepoch(?) * 1000)`;
}

/** The clause and its parameter together so one cannot be added alone; the identity pair when no boundary. */
export function withSessionBoundary(
  agentId: string, col = 'created_at',
): { sql: string; params: string[] } {
  const boundary = sessionBoundaryText(agentId);
  return boundary
    ? { sql: ` AND ${sessionBoundaryClause(col)}`, params: [boundary] }
    : { sql: '', params: [] };
}
