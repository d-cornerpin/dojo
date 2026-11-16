import type Database from 'better-sqlite3';

/** The raw tokens of the agent's top-level summaries, the notes its view may show. */
export const heldSummaryTokens = (db: Database.Database, agentId: string): number => (db.prepare(
  'SELECT COALESCE(SUM(s.token_count), 0) AS t FROM summaries s WHERE s.agent_id = ? AND s.id NOT IN (SELECT parent_id FROM summary_parents)',
).get(agentId) as { t: number }).t;
