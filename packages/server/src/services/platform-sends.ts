// ════════════════════════════════════════════════════════════════════════════════════════
// services/platform-sends.ts — the record of every email the platform itself sends (P44, review C2).
//
// An email the platform sends from the owner's own connected mailbox (send-as, once the owner allows it)
// to the agent's mailbox arrives with a genuine DMARC pass from an owner address. It is still the agent's
// own mail, never the owner speaking. So every send path stamps its message with a send id BEFORE it goes
// out, records that id here, and the mail intake (`mail-owner-intake.ts`) refuses owner status to any
// inbound mail carrying a recorded id. The record is the engine's, written at send time — never the text
// of a message and never a time window.
//
//   Gmail:   we write our own `Message-ID` and an `X-Platform-Send-Id` header into the raw message.
//   Outlook: `sendMail` carries an `x-platform-send-id` header; reply and forward cannot take one, so after
//            the send the Sent Items copy is found and its `internetMessageId` is recorded (tools-write).
// ════════════════════════════════════════════════════════════════════════════════════════

import { randomUUID } from 'node:crypto';
import { getDb } from '../db/connection.js';

const KEY = 'platform_send:';
export const SEND_ID_HEADER = 'X-Platform-Send-Id';

/** The canonical form an id is recorded and looked up in: no angle brackets, lower-cased, trimmed. */
const norm = (id: string): string => id.trim().replace(/^<|>$/g, '').toLowerCase();

/** Record ids (an RFC Message-ID, a send id) as sent by the platform. Best effort: a failed write must not fail a send. */
export function recordPlatformSend(...ids: Array<string | null | undefined>): void {
  try {
    const put = getDb().prepare(`INSERT OR IGNORE INTO config (key, value, updated_at) VALUES (?, ?, datetime('now'))`);
    for (const id of ids) if (id && norm(id)) put.run(KEY + norm(id), new Date().toISOString());
  } catch { /* the send itself is not the place to fail */ }
}

/** Mint and record a send id before a message goes out; the Message-ID is derived from it. */
export function newPlatformSend(): { sendId: string; messageId: string } {
  const sendId = randomUUID();
  const messageId = `<${sendId}@send.invalid>`;
  recordPlatformSend(sendId, messageId);
  return { sendId, messageId };
}

/** The raw header lines every Gmail send carries. */
export function platformSendHeaderLines(): string[] {
  const { sendId, messageId } = newPlatformSend();
  return [`Message-ID: ${messageId}`, `${SEND_ID_HEADER}: ${sendId}`];
}

/** Did the platform send the message these headers belong to? Reads only the id headers (Message-ID, X-Platform-Send-Id) — never the body. */
export function isPlatformSent(headers: ReadonlyArray<{ name: string; value: string }>): boolean {
  const ids = headers.filter((h) => ['message-id', SEND_ID_HEADER.toLowerCase()].includes(h.name.toLowerCase())).map((h) => norm(h.value)).filter(Boolean);
  if (ids.length === 0) return false;
  try {
    const q = getDb().prepare('SELECT 1 FROM config WHERE key = ?');
    return ids.some((id) => q.get(KEY + id) !== undefined);
  } catch { return false; }
}

/** The header Graph's `sendMail` message carries (`x-` names are the only custom ones Graph accepts); the send id is recorded first. */
export function graphSendHeaders(): Array<{ name: string; value: string }> {
  return [{ name: SEND_ID_HEADER.toLowerCase(), value: newPlatformSend().sendId }];
}
