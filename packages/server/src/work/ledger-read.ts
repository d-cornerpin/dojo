// v3.5 field fix 3: the task ledger's READERS, as a leaf (the database and the key prefixes only).
// `tracker/looked-at.ts` reads them for the verdict record, and that module is imported by the spine
// (`work/tracker-store.ts`), so these must not pull `ledger-store.ts`'s provider imports into it (the
// first-import census, `memory/__tests__/the-assembler-initializes-when-it-is-imported-first.test.ts`).
// `ledger-store.ts` re-exports them for every other caller.
import { getDb } from '../db/connection.js';
import { COMMAND_KEY, FILE_KEY } from '../tools/item-keys.js';

/** SQL: this ledger row is an item (anything but a command record). */
export const IS_ITEM = `substr(item_key, 1, ${COMMAND_KEY.length}) <> '${COMMAND_KEY}'`;

/** `touched` and `byTool` are ITEMS (mailbox items and files); `commands` is how many distinct commands ran. */
export function ledgerTotals(workId: string): { touched: number; commands: number; lastAt: number | null; byTool: Array<{ tool: string; n: number }> } {
  const db = getDb();
  const t = db.prepare(
    `SELECT COALESCE(SUM(CASE WHEN ${IS_ITEM} THEN 1 ELSE 0 END), 0) AS n, COUNT(*) AS all_n, MAX(last_at) AS last FROM work_ledger WHERE work_id = ?`,
  ).get(workId) as { n: number; all_n: number; last: number | null };
  const byTool = db.prepare(`SELECT tool, COUNT(*) AS n FROM work_ledger WHERE work_id = ? AND ${IS_ITEM} GROUP BY tool ORDER BY n DESC, tool`).all(workId) as Array<{ tool: string; n: number }>;
  return { touched: t.n, commands: t.all_n - t.n, lastAt: t.last, byTool };
}

/** One file or command entry on a task's ledger, as the validation request and the verdict record show it. */
export interface LedgerWorkEntry { kind: 'file' | 'command'; what: string; tool: string; status: string | null }

/** The task's file and command entries, oldest first. Mailbox items are counted (`ledgerTotals`), not
 *  listed: a sweep touches thousands of ids and a path or a command is what a reviewer can open. */
export function ledgerWorkEntries(workId: string): LedgerWorkEntry[] {
  const rows = getDb().prepare(
    `SELECT item_key AS k, tool, detail FROM work_ledger WHERE work_id = ?
       AND (substr(item_key, 1, ${FILE_KEY.length}) = '${FILE_KEY}' OR substr(item_key, 1, ${COMMAND_KEY.length}) = '${COMMAND_KEY}')
     ORDER BY first_at, rowid`,
  ).all(workId) as Array<{ k: string; tool: string; detail: string | null }>;
  return rows.map((r) => r.k.startsWith(FILE_KEY)
    ? { kind: 'file' as const, what: r.k.slice(FILE_KEY.length), tool: r.tool, status: null }
    : { kind: 'command' as const, what: r.k.slice(COMMAND_KEY.length), tool: r.tool, status: r.detail });
}


/** The task's file and command entries in the order a review SHOWS them (review M1): the commands
 *  that failed first (newest first), then the files the work wrote (newest first), then the commands
 *  that exited 0 (newest first). The ledger keeps everything; a reader lays this out in its own room. */
export function ledgerListing(workId: string): LedgerWorkEntry[] {
  const rows = getDb().prepare(
    `SELECT item_key AS k, tool, detail FROM work_ledger WHERE work_id = ?
       AND (substr(item_key, 1, ${FILE_KEY.length}) = '${FILE_KEY}' OR substr(item_key, 1, ${COMMAND_KEY.length}) = '${COMMAND_KEY}')
     ORDER BY last_at DESC, rowid DESC`,
  ).all(workId) as Array<{ k: string; tool: string; detail: string | null }>;
  const entries = rows.map((r): LedgerWorkEntry => (r.k.startsWith(FILE_KEY)
    ? { kind: 'file', what: r.k.slice(FILE_KEY.length), tool: r.tool, status: null }
    : { kind: 'command', what: r.k.slice(COMMAND_KEY.length), tool: r.tool, status: r.detail }));
  const failed = entries.filter((e) => e.kind === 'command' && e.status !== 'exit 0');
  const files = entries.filter((e) => e.kind === 'file');
  const clean = entries.filter((e) => e.kind === 'command' && e.status === 'exit 0');
  return [...failed, ...files, ...clean];
}
