import { getDb } from '../db/connection.js';
import { ownerConditionCleared, tellOwner } from '../healer/owner-notices.js';

// THE OWNER'S CARD FOR A FAILING WATCHER, AND ITS RECORD. One config row per watcher holds a map by ACCOUNT (Teams has one
// account, keyed by its own name): the truth about "already alerted", so after a restart a still-failing account is not
// told again and an account that recovered meanwhile clears on its first good poll. Its card (`watcher:<name>:<account>`)
// stands while the entry does and its subject (the watched account) still exists and is still watched; the account
// tables' writers call `reconcileWatcherCards` after every change.

type Name = 'gmail' | 'outlook' | 'teams';
type Entry = { at: number; words: string };
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
  tellOwner(`watcher:${name}:${account}`, words);
}

/** This account's watcher recovered: take its failure off the record, returning what was told. */
export function clearFailure(name: Name, account: string): Entry | null {
  const record = readRecord(name);
  const told = record[account];
  if (told === undefined) return null;
  delete record[account];
  writeRecord(name, record);
  ownerConditionCleared(`watcher:${name}:${account}`);
  return told;
}

/** THE "is this account's mail watched" rule, shared: the Gmail and Outlook watchers poll an
 *  account when it is connected AND this holds (their `isMonitored`), and a watcher card's
 *  subject stands while this holds (round 7, re-review P7). Connected is left out here on purpose:
 *  a benched account's failure is still live, and reconnecting resumes polls that clear it. A
 *  service missing from `services` defaults on, as both workspaces' service defaults do. */
export function watchedForMail(
  v: { enabled: boolean; watchEmail: boolean; services: Partial<Record<string, boolean>> }, service: 'gmail' | 'outlook',
): boolean {
  return v.enabled && v.watchEmail && v.services[service] !== false;
}

/** Is the watched subject still there and still watched? */
function subjectStands(name: Name, account: string): boolean {
  const db = getDb();
  if (name !== 'teams') {
    const row = db.prepare(name === 'gmail'
      ? 'SELECT enabled, watch_email, enabled_services FROM google_accounts WHERE id = ?'
      : 'SELECT enabled, watch_email, enabled_services FROM microsoft_accounts WHERE id = ?')
      .get(account) as { enabled: number; watch_email: number; enabled_services: string | null } | undefined;
    if (!row) return false;
    let services: Partial<Record<string, boolean>> = {};
    try { services = JSON.parse(row.enabled_services ?? '{}') as Partial<Record<string, boolean>>; } catch { /* defaults */ }
    return watchedForMail({ enabled: !!row.enabled, watchEmail: !!row.watch_email, services }, name === 'gmail' ? 'gmail' : 'outlook');
  }
  const ms = db.prepare("SELECT enabled, enabled_services FROM microsoft_accounts WHERE kind = 'agent' ORDER BY position LIMIT 1")
    .get() as { enabled: number; enabled_services: string | null } | undefined;
  if (!ms || !ms.enabled) return false;
  try { return (JSON.parse(ms.enabled_services ?? '{}') as { teams?: boolean }).teams !== false; } catch { return true; }
}

/** After any change to the watched accounts: an entry whose subject is gone is removed, and its
 *  card leaves every open dashboard now. */
export function reconcileWatcherCards(): void {
  try {
    for (const name of Object.keys(LATCH_KEY) as Name[]) {
      const record = readRecord(name);
      const gone = Object.entries(record).filter(([account]) => !subjectStands(name, account));
      if (gone.length === 0) continue;
      for (const [account] of gone) delete record[account];
      writeRecord(name, record);
      for (const [account] of gone) ownerConditionCleared(`watcher:${name}:${account}`);
    }
  } catch { /* best-effort: the reload list still checks the subject */ }
}

/** Does the card `watcher:<name>:<account>` still stand: the failure on record, its subject still watched? */
export function watcherCardStands(id: string): boolean {
  const [name, account = ''] = id.split(/:(.*)/s) as [Name, string];
  return name in LATCH_KEY && readRecord(name)[account] !== undefined && subjectStands(name, account);
}
