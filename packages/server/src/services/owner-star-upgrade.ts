// One-time upgrade: write down the owner the previous safe-sender reader implied. That reader gave every
// list an owner on read (the entry matching the legacy `imessage_default_sender` key, else the first entry).
// The reader no longer promotes anyone, so an upgraded box would lose its owner and the main agent could not
// text them. This stars, once, exactly the entry the old reader treated as the owner:
//   * only a list with NO starred entry is touched; a bare-address list (first entry is the owner) is left alone;
//   * it runs ONCE (the marker `owner_star_conversion_done` is written last), so nothing added later is starred.
// Boot step: index.ts, beside the other idempotent config upgrades.

import { getDb } from '../db/connection.js';
import { createLogger } from '../logger.js';
import { configKeyToChannel } from '../contacts/from-safe-senders.js';
import { addressesMatch, readLegacyDefaultSender } from './safe-senders.js';

const logger = createLogger('owner-star-upgrade');
const DONE_KEY = 'owner_star_conversion_done';

export function starTheOwnersTheOldReaderImplied(): { converted: string[]; skipped: boolean } {
  const db = getDb();
  const done = db.prepare('SELECT value FROM config WHERE key = ?').get(DONE_KEY) as { value: string } | undefined;
  if (done) return { converted: [], skipped: true };

  const legacy = readLegacyDefaultSender() || null;   // the one reader of the legacy key
  const converted: string[] = [];

  const rows = db
    .prepare("SELECT key, value FROM config WHERE key LIKE '%approved_senders%' OR key LIKE '%approved_callers%'")
    .all() as Array<{ key: string; value: string }>;
  for (const { key, value } of rows) {
    if (!configKeyToChannel(key)) continue;
    let list: unknown;
    try { list = JSON.parse(value); } catch { continue; }
    if (!Array.isArray(list)) continue;

    // The entries the old reader kept (a non-empty address), and whether any was its owner already.
    const kept: Array<{ index: number; address: string }> = [];
    let hadOwner = false;
    list.forEach((item, index) => {
      if (typeof item === 'string') {
        const address = item.trim();
        if (!address) return;
        kept.push({ index, address });
        if (index === 0) hadOwner = true;                       // a bare-address list: its first entry
      } else if (item && typeof item === 'object') {
        const o = item as { address?: unknown; is_primary?: unknown };
        const address = typeof o.address === 'string' ? o.address.trim() : '';
        if (!address) return;
        kept.push({ index, address });
        if (o.is_primary === true) hadOwner = true;
      }
    });
    if (hadOwner || kept.length === 0) continue;

    const match = legacy ? kept.find((k) => addressesMatch(k.address, legacy)) : undefined;
    const chosen = match ?? kept[0];
    const item = list[chosen.index];
    list[chosen.index] = typeof item === 'string'
      ? { address: chosen.address, name: chosen.address, is_primary: true }
      : { ...(item as object), is_primary: true };
    db.prepare("UPDATE config SET value = ?, updated_at = datetime('now') WHERE key = ?").run(JSON.stringify(list), key);
    converted.push(key);
  }

  db.prepare("INSERT INTO config (key, value, updated_at) VALUES (?, '1', datetime('now')) ON CONFLICT(key) DO NOTHING").run(DONE_KEY);
  if (converted.length > 0) logger.info('Starred the owner the previous reader implied (one time)', { lists: converted });
  return { converted, skipped: false };
}

/** Boot entry: never throws (a failed conversion retries next boot, because the marker is written last). */
export async function starTheOwnersAtBoot(): Promise<void> {
  try { starTheOwnersTheOldReaderImplied(); }
  catch (err) { logger.warn('Owner-star conversion failed (non-fatal; retries next boot)', { error: err instanceof Error ? err.message : String(err) }); }
}
