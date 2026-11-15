import type Database from 'better-sqlite3';

/** The raw tokens of the summaries in an agent's view items (`context_items`). */
export const heldSummaryTokens = (db: Database.Database, agentId: string): number => (db.prepare(
  "SELECT COALESCE(SUM(s.token_count), 0) AS t FROM summaries s JOIN context_items ci ON ci.item_id = s.id WHERE ci.agent_id = ? AND ci.item_type = 'summary'",
).get(agentId) as { t: number }).t;
