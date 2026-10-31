// The watchers' "already notified" list (`gmail_notified_<account>` / `outlook_notified_<account>` in `config`), saved by the
// watchers after EACH message they act on, not only at the end of a poll: a poll that throws part-way must not make the
// next poll read the same messages again (t280b — a re-read of an owner email was judged a replay).
import { getDb } from '../db/connection.js';

export function persistNotifiedIds(key: string, ids: ReadonlySet<string>): void {
  const value = JSON.stringify([...ids].slice(-200));   // the list was always capped at the last 200
  getDb().prepare(`
    INSERT INTO config (key, value, updated_at) VALUES (?, ?, datetime('now'))
    ON CONFLICT(key) DO UPDATE SET value = ?, updated_at = datetime('now')
  `).run(key, value, value);
}
