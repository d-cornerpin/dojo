// ════════════════════════════════════════════════════════════════════════════════════════
// "CONNECTION EXPIRED": THE OWNER'S CARD FOR A BENCHED GOOGLE OR MICROSOFT ACCOUNT (t138 round 4).
//
// When an account's sign-in dies, the platform benches it and texts the owner once. The same
// words wait on his dashboard until he dismisses them, re-derived on every load from the
// account's own row (no new store): `owner_notice` (migration 193) holds `{ at, words,
// dismissedAt? }` while the account stays benched. When the sign-in is restored — by the
// recovery probe or by the owner reconnecting in Settings, both through the table's one
// writer — the notice is cleared and the card leaves every open dashboard at once.
// ════════════════════════════════════════════════════════════════════════════════════════

import { getDb } from '../db/connection.js';
import { ownerCardEnded } from './owner-card-frames.js';

export type AccountTable = 'google_accounts' | 'microsoft_accounts';
type Notice = { at: number; words: string; dismissedAt?: number };

function noticeOf(raw: string | null | undefined): Notice | null {
  try { return raw ? JSON.parse(raw) as Notice : null; } catch { return null; }
}

/** The account was benched and the owner is being told: keep the words. Returns them. */
export function noteSignInExpired(table: AccountTable, id: string, words: string): string {
  try {
    getDb().prepare(`UPDATE ${table} SET owner_notice = ? WHERE id = ?`).run(JSON.stringify({ at: Date.now(), words }), id);
  } catch { /* the text still goes; only the lasting card is lost */ }
  return words;
}

/** The sign-in is back: the incident is over, and its card leaves. */
export function signInRestored(table: AccountTable, id: string): void {
  try {
    const db = getDb();
    const row = db.prepare(`SELECT owner_notice FROM ${table} WHERE id = ?`).get(id) as { owner_notice: string | null } | undefined;
    const notice = noticeOf(row?.owner_notice);
    if (!row?.owner_notice) return;
    db.prepare(`UPDATE ${table} SET owner_notice = NULL WHERE id = ?`).run(id);
    if (notice) ownerCardEnded(notice.words);
  } catch { /* a card left standing is dismissable; a failed reconnect write is not this module's */ }
}

/** The expired-sign-in owner cards a dashboard shows on load: benched, told, not dismissed. */
export function accountOwnerCards(): Array<{ words: string; severity: 'critical'; dismiss: () => void }> {
  const db = getDb();
  return (['google_accounts', 'microsoft_accounts'] as const).flatMap((table) => {
    const rows = db.prepare(`SELECT id, owner_notice FROM ${table} WHERE owner_notice IS NOT NULL AND connected = 0`)
      .all() as Array<{ id: string; owner_notice: string }>;
    return rows.flatMap((r) => {
      const notice = noticeOf(r.owner_notice);
      if (!notice || notice.dismissedAt !== undefined) return [];
      const dismiss = (): void => {
        db.prepare(`UPDATE ${table} SET owner_notice = ? WHERE id = ?`).run(JSON.stringify({ ...notice, dismissedAt: Date.now() }), r.id);
      };
      return [{ words: notice.words, severity: 'critical' as const, dismiss }];
    });
  });
}
