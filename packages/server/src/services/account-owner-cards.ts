// The owner's card for a benched Google or Microsoft account (`signin:<google|microsoft>:<id>`): the account's
// `owner_notice` holds the incident and the card stands until the sign-in is restored or the account deleted.

import { getDb } from '../db/connection.js';
import { ownerConditionCleared, tellOwner } from '../healer/owner-notices.js';

export type AccountTable = 'google_accounts' | 'microsoft_accounts';

/** Each table's statement spelled out in full (no table name is ever interpolated into SQL). */
const SET: Record<AccountTable, string> = {
  google_accounts: 'UPDATE google_accounts SET owner_notice = ? WHERE id = ?',
  microsoft_accounts: 'UPDATE microsoft_accounts SET owner_notice = ? WHERE id = ?',
};
const keyOf = (table: AccountTable, id: string): string => `signin:${table === 'google_accounts' ? 'google' : 'microsoft'}:${id}`;

export function noteSignInExpired(table: AccountTable, id: string, words: string): void {
  try { getDb().prepare(SET[table]).run(JSON.stringify({ at: Date.now(), words }), id); } catch { /* the card still goes */ }
  tellOwner(keyOf(table, id), words);
}

export function signInRestored(table: AccountTable, id: string): void {
  try { getDb().prepare(SET[table]).run(null, id); } catch { /* a failed reconnect write is not this module's */ }
  ownerConditionCleared(keyOf(table, id));
}

export const accountRemoved = (table: AccountTable, id: string): void => ownerConditionCleared(keyOf(table, id));
