// The record of every email the platform itself sends. Mail from the owner's own mailbox to the agent passes
// DMARC as an owner address yet is the agent's own, so every send stamps an id BEFORE it goes out and
// `mail-owner-intake.ts` refuses owner status to inbound mail carrying a recorded id. Gmail: our Message-ID
// plus an X-Platform-Send-Id header. Outlook: that header; the Sent Items Message-ID is a second key.

import { randomUUID } from 'node:crypto';
import { getDb } from '../db/connection.js';

const KEY = 'platform_send:';
export const SEND_ID_HEADER = 'X-Platform-Send-Id';

const norm = (id: string): string => id.trim().replace(/^<|>$/g, '').toLowerCase();

/** Drops this kind of mail record (`config` rows under `prefix`) once it is 90 days old, so the rows do not pile up. */
export function forgetOldMailRecords(prefix: string): void {
  getDb().prepare(`DELETE FROM config WHERE substr(key, 1, ?) = ? AND updated_at < datetime('now', '-90 days')`).run(prefix.length, prefix);
}

/** THROWS if unwritable: an unrecorded send could later be read as the owner speaking, so none is made. */
function mustRecord(ids: string[]): void {
  try {
    const put = getDb().prepare(`INSERT OR IGNORE INTO config (key, value, updated_at) VALUES (?, ?, datetime('now'))`);
    for (const id of ids) put.run(KEY + norm(id), new Date().toISOString());
  } catch (err) {
    throw new Error(`Nothing was sent: the platform could not save its record of this outgoing email (${err instanceof Error ? err.message : String(err)}). Try again.`);
  }
}

/** A provider-issued Message-ID, recorded as a second key when known; best effort. */
export function recordPlatformSend(...ids: Array<string | null | undefined>): void {
  try {
    const put = getDb().prepare(`INSERT OR IGNORE INTO config (key, value, updated_at) VALUES (?, ?, datetime('now'))`);
    for (const id of ids) if (id && norm(id)) put.run(KEY + norm(id), new Date().toISOString());
  } catch { /* the send itself is not the place to fail */ }
}

export function newPlatformSend(): { sendId: string; messageId: string } {
  const sendId = randomUUID();
  const messageId = `<${sendId}@send.invalid>`;
  mustRecord([sendId, messageId]);
  try { forgetOldMailRecords(KEY); } catch { /* a later send prunes */ }
  return { sendId, messageId };
}

export function platformSendHeaderLines(): string[] {
  const { sendId, messageId } = newPlatformSend();
  return [`Message-ID: ${messageId}`, `${SEND_ID_HEADER}: ${sendId}`];
}

export function isPlatformSent(headers: ReadonlyArray<{ name: string; value: string }>): boolean {
  const ids = headers.filter((h) => ['message-id', SEND_ID_HEADER.toLowerCase()].includes(h.name.toLowerCase())).map((h) => norm(h.value)).filter(Boolean);
  if (ids.length === 0) return false;
  try {
    const q = getDb().prepare('SELECT 1 FROM config WHERE key = ?');
    return ids.some((id) => q.get(KEY + id) !== undefined);
  } catch { return false; }
}

/** Graph accepts only `x-` custom header names; the send id is recorded before the message goes out. */
export function graphSendHeaders(): Array<{ name: string; value: string }> {
  return [{ name: SEND_ID_HEADER.toLowerCase(), value: newPlatformSend().sendId }];
}
