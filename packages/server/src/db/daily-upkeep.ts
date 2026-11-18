// Once a day: the Google and Microsoft activity logs keep 180 days, and 30 for the watchers' own polls (agent id
// 'system'); then the planner statistics are refreshed. Nothing else is trimmed here.
import { getDb } from './connection.js';
import { createLogger } from '../logger.js';

const logger = createLogger('db-upkeep');
const ACTIVITY_TABLES = ['microsoft_activity', 'google_activity'] as const;
const BATCH = 5000;

export async function runDailyDatabaseUpkeep(): Promise<void> {
  try {
    const db = getDb();
    let trimmed = 0;
    for (const table of ACTIVITY_TABLES) {
      const trim = db.prepare(`DELETE FROM ${table} WHERE rowid IN (SELECT rowid FROM ${table}
        WHERE created_at < datetime('now', '-180 days') OR (agent_id = 'system' AND created_at < datetime('now', '-30 days'))
        LIMIT ${BATCH})`);
      for (;;) {
        const n = trim.run().changes;
        trimmed += n;
        if (n < BATCH) break;
        await new Promise<void>((resolve) => setImmediate(resolve));   // a long backlog never holds the server
      }
    }
    db.pragma('optimize');
    if (trimmed > 0) logger.info('Old activity log rows trimmed', { trimmed });
  } catch (err) {
    logger.warn('Daily database upkeep failed', { error: err instanceof Error ? err.message : String(err) });
  }
}
