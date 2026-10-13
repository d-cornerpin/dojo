import { getDb } from '../db/connection.js';

// ── THE OWNER'S CARD FOR A FAILING WATCHER (t138 rounds 3-4) ──
//
// The failure text is told once per failure; its words wait on the owner's dashboard until he
// dismisses them, and the recovery all-clear removes that card. The record is a config latch
// per watcher (`{ at, words, dismissedAt? }`). The watcher's own "already alerted" flag lives in
// its process (and one flag covers every account of that watcher), so a latch written before
// this process started has no owner: the card is not shown from it, and a failure that is
// still there re-alerts and writes a fresh one. A card never outlives a recovery it cannot see.
type Name = 'gmail' | 'outlook' | 'teams';
const LATCH_KEY: Record<Name, string> = {
  gmail: 'owner_notice_watcher_gmail', outlook: 'owner_notice_watcher_outlook', teams: 'owner_notice_watcher_teams',
};
type Told = { at: number; words: string; dismissedAt?: number };
const PROCESS_STARTED_AT = Date.now() - process.uptime() * 1000;

export function readTold(name: Name): Told | null {
  try {
    const row = getDb().prepare('SELECT value FROM config WHERE key = ?').get(LATCH_KEY[name]) as { value: string } | undefined;
    return row ? JSON.parse(row.value) as Told : null;
  } catch { return null; }
}

export function writeTold(name: Name, told: Told | null): void {
  try {
    const db = getDb();
    if (told === null) db.prepare('DELETE FROM config WHERE key = ?').run(LATCH_KEY[name]);
    else db.prepare(`INSERT INTO config (key, value, updated_at) VALUES (?, ?, datetime('now'))
                     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = datetime('now')`).run(LATCH_KEY[name], JSON.stringify(told));
  } catch { /* the text still goes; only the lasting card is lost */ }
}

/** The failing-watcher owner cards a dashboard shows on load. */
export function watcherOwnerCards(): Array<{ words: string; severity: 'critical'; dismiss: () => void }> {
  return (Object.keys(LATCH_KEY) as Array<Name>).flatMap((name) => {
    const told = readTold(name);
    if (!told || told.dismissedAt !== undefined || told.at < PROCESS_STARTED_AT) return [];
    return [{ words: told.words, severity: 'critical' as const, dismiss: () => writeTold(name, { ...told, dismissedAt: Date.now() }) }];
  });
}
