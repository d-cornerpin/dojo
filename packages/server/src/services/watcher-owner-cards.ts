import { getDb } from '../db/connection.js';

// ── THE OWNER'S CARD FOR A FAILING WATCHER, AND ITS RECORD (t138 rounds 3-5) ──
//
// A failing mail/chat watcher texts the owner once per failure; the words wait on his dashboard
// until he dismisses them, and the recovery all-clear removes the card. The record is one config
// row per watcher holding a map by ACCOUNT (`{ [account]: { at, words, dismissedAt? } }`; Teams
// has one account, keyed by its own name). It is the truth about "already alerted", not the
// watcher's in-process flag: after a restart a still-failing account neither texts again nor
// loses its card, and an account that recovered while the server was down clears it on its first
// good poll (the watchers consult `watcherFailingOnRecord`). One account's success never clears
// another's failure.

type Name = 'gmail' | 'outlook' | 'teams';
type Entry = { at: number; words: string; dismissedAt?: number };
const LATCH_KEY: Record<Name, string> = {
  gmail: 'owner_notice_watcher_gmail', outlook: 'owner_notice_watcher_outlook', teams: 'owner_notice_watcher_teams',
};

function readRecord(name: Name): Record<string, Entry> {
  try {
    const row = getDb().prepare('SELECT value FROM config WHERE key = ?').get(LATCH_KEY[name]) as { value: string } | undefined;
    const parsed = row ? JSON.parse(row.value) as Record<string, Entry> : {};
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch { return {}; }
}

function writeRecord(name: Name, record: Record<string, Entry>): void {
  try {
    const db = getDb();
    if (Object.keys(record).length === 0) db.prepare('DELETE FROM config WHERE key = ?').run(LATCH_KEY[name]);
    else db.prepare(`INSERT INTO config (key, value, updated_at) VALUES (?, ?, datetime('now'))
                     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = datetime('now')`).run(LATCH_KEY[name], JSON.stringify(record));
  } catch { /* the text still goes; only the lasting card is lost */ }
}

/** Is this account's failure on record (told, not yet recovered)? */
export function watcherFailingOnRecord(name: Name, account: string = name): boolean {
  return readRecord(name)[account] !== undefined;
}

/** The owner is being told this account's watcher is failing. */
export function recordFailureTold(name: Name, account: string, words: string): void {
  writeRecord(name, { ...readRecord(name), [account]: { at: Date.now(), words } });
}

/** This account's watcher recovered: take its failure off the record, returning what was told. */
export function clearFailure(name: Name, account: string): Entry | null {
  const record = readRecord(name);
  const told = record[account];
  if (told === undefined) return null;
  delete record[account];
  writeRecord(name, record);
  return told;
}

/** The failing-watcher owner cards a dashboard shows on load (one per account still failing). */
export function watcherOwnerCards(): Array<{ words: string; severity: 'critical'; dismiss: () => void }> {
  return (Object.keys(LATCH_KEY) as Name[]).flatMap((name) => Object.entries(readRecord(name)).flatMap(([account, told]) => {
    if (told.dismissedAt !== undefined) return [];
    const dismiss = (): void => writeRecord(name, { ...readRecord(name), [account]: { ...told, dismissedAt: Date.now() } });
    return [{ words: told.words, severity: 'critical' as const, dismiss }];
  }));
}
