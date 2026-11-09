// "CONNECTION EXPIRED": THE OWNER'S CARD FOR A BENCHED GOOGLE OR MICROSOFT ACCOUNT. The account's own `owner_notice` holds
// the incident while it stays benched; its card (`signin:<google|microsoft>:<id>`) stands while it does. A restored
// sign-in (the recovery probe, or the owner reconnecting) or a deleted account ends both.

import { getDb } from '../db/connection.js';
import { ownerConditionCleared, tellOwner } from '../healer/owner-notices.js';

export type AccountTable = 'google_accounts' | 'microsoft_accounts';

/** Each table's statement spelled out in full (no table name is ever interpolated into SQL). */
const SET: Record<AccountTable, string> = {
  google_accounts: 'UPDATE google_accounts SET owner_notice = ? WHERE id = ?',
  microsoft_accounts: 'UPDATE microsoft_accounts SET owner_notice = ? WHERE id = ?',
};
const keyOf = (table: AccountTable, id: string): string => `signin:${table === 'google_accounts' ? 'google' : 'microsoft'}:${id}`;

/** The account was benched: the incident is recorded and the owner's card raised. */
export function noteSignInExpired(table: AccountTable, id: string, words: string): void {
  try { getDb().prepare(SET[table]).run(JSON.stringify({ at: Date.now(), words }), id); } catch { /* the card still goes */ }
  tellOwner(keyOf(table, id), words);
}

/** The sign-in is back: the incident is over, and its card leaves. */
export function signInRestored(table: AccountTable, id: string): void {
  try { getDb().prepare(SET[table]).run(null, id); } catch { /* a failed reconnect write is not this module's */ }
  ownerConditionCleared(keyOf(table, id));
}

/** The account is being deleted: its expired-sign-in card ends, live. */
export const accountRemoved = (table: AccountTable, id: string): void => ownerConditionCleared(keyOf(table, id));
