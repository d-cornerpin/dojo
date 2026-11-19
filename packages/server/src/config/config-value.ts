import { getDb } from '../db/connection.js';

/** The one writer of a config row: inserts the key or replaces its value, and stamps the time. */
export function setConfigValue(key: string, value: string): void {
  getDb().prepare(`
    INSERT INTO config (key, value, updated_at) VALUES (?, ?, datetime('now'))
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = datetime('now')
  `).run(key, value);
}
