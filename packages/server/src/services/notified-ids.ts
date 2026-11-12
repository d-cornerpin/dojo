// Watchers' "already notified" list (`*_notified_<account>` in `config`), saved after EACH message acted on:
// a poll that throws part-way must not make the next poll re-read the same messages.
import { getDb } from '../db/connection.js';

export function persistNotifiedIds(key: string, ids: ReadonlySet<string>): void {
  const value = JSON.stringify([...ids].slice(-200));   // capped at the last 200
  getDb().prepare(`
    INSERT INTO config (key, value, updated_at) VALUES (?, ?, datetime('now'))
    ON CONFLICT(key) DO UPDATE SET value = ?, updated_at = datetime('now')
  `).run(key, value, value);
}
