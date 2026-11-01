// ════════════════════════════════════════════════════════════════════════════════════════
// services/mail-owner-intake.ts — is this email the owner speaking? (P44, owner rulings 2026-10-26/27)
//
// The ONE place either mail watcher asks. The owner's email identity is the addresses of the Google
// and Microsoft accounts connected as kind 'user' (`owner-mailboxes.ts`, read from the account tables
// on every call, never stored twice). An email counts as the owner ONLY when the provider's own
// authentication result confirms it (`mail-owner-verdict.ts`: DMARC pass aligned with the From domain,
// read from the provider's header, never the body) AND the single From address is exactly one of
// those addresses. Everything else is an outside sender — and when the From names an owner address
// but the check does not confirm it, the notice says so plainly.
//
// The owner's words are his NEW words only: the body is read from the provider, quoted and forwarded
// text is cut (`mail-quoted-text.ts`), and those words ride the inbound meta (`ownerWords`). The owner
// door (`tracker/owner-words.ts`) reads that field and never the notice or the preview, so nothing the
// agent quoted back, and nothing the platform wrote, can be mistaken for him.
//
// Fail closed: a header or body the provider will not give is "unconfirmed" / empty words, never owner.
// ════════════════════════════════════════════════════════════════════════════════════════

import { getDb } from '../db/connection.js';
import { ownerMailboxes } from './owner-mailboxes.js';
import { ownerEmailVerdict, type MailHeader } from './mail-owner-verdict.js';
import { isOwnerCommandText } from './owner-command-words.js';
import { newTextOf } from './mail-quoted-text.js';
import { stripHtmlTags } from '../agent/html-text.js';
import { extractOwnGmailText, type GmailBodyPart } from '../google/gmail-body.js';
import { googleRead } from '../google/client.js';
import { msGraphRead } from '../microsoft/client.js';
import { isPlatformSent } from './platform-sends.js';
import type { OwnerEmailNotice } from '../tools/inbound-fences.js';

/** `none`: the From is not an owner address (or the mail is in the owner's own inbox) — nothing to say. */
export type OwnerEmailOutcome = { state: 'none' } | OwnerEmailNotice;

export interface OwnerEmailInput {
  provider: 'gmail' | 'outlook';
  /** Where the agent's own address sits on the email. An owner email counts only when it is on To or Cc: DMARC proves who signed a
   *  message, not that it was written to the agent, so a blind copy or a list delivery of an old owner email never counts. */
  placement: 'to' | 'cc' | 'neither';
  /** The provider's own identity for THIS delivery (`gmail:<account>:<message id>` / `outlook:<account>:<item id>`): the replay guard
   *  tells a re-read of the same delivery from a different delivery carrying the same Message-ID. */
  deliveryRef: string;
  /** The watched mailbox's kind. Only the agent's own mailbox can receive the owner's words. */
  kind: 'agent' | 'user';
  /** The From header value (Gmail) or the bare From address (Outlook). */
  from: string;
  /** Every header the provider holds, TOPMOST FIRST; null when it would not give them. Called only for a message whose From is an owner address. */
  headers: () => Promise<MailHeader[] | null>;
  /** The message's plain text with the quoted thread cut away where the provider can do it; null when unavailable. */
  newBody: () => Promise<string | null>;
  /** Is this a meeting item (an invitation, response or cancellation, or any message carrying a calendar part)? Those are sent by the
   *  calendar machinery from the owner's own account, with text the platform or a third party chose — never the owner speaking. Unknown = yes. */
  isMeeting: () => Promise<boolean>;
}

/** True when this delivery is the one that first used the Message-ID: the first look records `deliveryRef` (provider + account +
 *  the provider's own item id) as the row's value, and any later look at the SAME delivery is the same sighting, so a poll that
 *  threw part-way and re-reads a message gives the same verdict. A DIFFERENT delivery carrying the Message-ID is a replay: false.
 *  A record that cannot be written or read is false (fail closed). */
function firstSighting(messageId: string, deliveryRef: string): 'first' | 'seen_before' | 'failed' {
  try {
    const key = `owner_mail_seen:${messageId.replace(/^<|>$/g, '')}`;
    const db = getDb();
    if (db.prepare(`INSERT OR IGNORE INTO config (key, value, updated_at) VALUES (?, ?, datetime('now'))`).run(key, deliveryRef).changes === 1) return 'first';
    return (db.prepare('SELECT value FROM config WHERE key = ?').get(key) as { value: string } | undefined)?.value === deliveryRef ? 'first' : 'seen_before';
  } catch { return 'failed'; }
}

const NOT_ABOUT_OWNER = new Set(['no_owner_addresses', 'from_not_single', 'from_not_owner']);

export async function judgeOwnerEmail(i: OwnerEmailInput): Promise<OwnerEmailOutcome> {
  if (i.kind !== 'agent') return { state: 'none' };
  const ownerAddresses = ownerMailboxes().map((m) => m.address);
  // Is the From an owner address at all? (No headers needed to answer that, so no extra fetch otherwise.)
  const claim = ownerEmailVerdict({ provider: i.provider, from: i.from, headers: [], ownerAddresses });
  if (claim.verdict === 'unconfirmed' && NOT_ABOUT_OWNER.has(claim.reason)) return { state: 'none' };
  if (claim.verdict === 'unconfirmed' && claim.reason === 'outlook_not_open') return { state: 'unconfirmed', reason: 'outlook_closed' };   // Outlook confirmation is closed (`outlook-owner-gate.ts`): no fetch
  if (i.placement === 'neither') return { state: 'unconfirmed', reason: 'bcc' };
  const headers = await i.headers().catch(() => null);
  // The provider's list must show the From it judged: none at all is a list it did not really give.
  if (!headers || !headers.some((h) => h.name.toLowerCase() === 'from')) return { state: 'unconfirmed', reason: 'check_failed' };
  // Mail the platform itself sent (from the owner's own mailbox, send-as) is never the owner speaking, whatever its DMARC says.
  if (isPlatformSent(headers)) return { state: 'none' };
  if (ownerEmailVerdict({ provider: i.provider, from: i.from, headers, ownerAddresses }).verdict !== 'owner') return { state: 'unconfirmed', reason: 'check_failed' };
  // A genuine owner email delivered again (a replay) carries the same Message-ID: each id counts once, and a message with none never.
  if (await i.isMeeting().catch(() => true)) return { state: 'none' };
  const messageId = headers.find((h) => h.name.toLowerCase() === 'message-id')?.value.trim().toLowerCase();
  if (!messageId) return { state: 'unconfirmed', reason: 'no_message_id' };
  const sighting = firstSighting(messageId, i.deliveryRef);
  if (sighting !== 'first') return { state: 'unconfirmed', reason: sighting === 'seen_before' ? 'seen_before' : 'check_failed' };
  const body = await i.newBody().catch(() => null);
  return { state: 'confirmed', words: body === null ? '' : newTextOf(body) };
}

/** Does a Gmail payload tree carry a calendar part? */
function hasCalendarPart(part: GmailBodyPart | undefined): boolean {
  if (!part) return false;
  const type = (part.mimeType ?? '').toLowerCase();
  return type.includes('calendar') || type === 'application/ics' || (part.parts ?? []).some(hasCalendarPart);
}

/** Gmail: the headers the watcher already fetched are the provider's, in message order; the full message is read once, only for a confirmed owner. */
export function judgeGmailOwnerEmail(a: { kind: 'agent' | 'user'; placement: OwnerEmailInput['placement']; from: string; headers: MailHeader[]; messageId: string; accountId: string }): Promise<OwnerEmailOutcome> {
  let read: Promise<GmailBodyPart | null> | null = null;
  const payload = (): Promise<GmailBodyPart | null> => read ??= googleRead(`https://gmail.googleapis.com/gmail/v1/users/me/messages/${encodeURIComponent(a.messageId)}?format=full`, 'system', 'Gmail Watcher', 'gmail_read', { messageId: a.messageId, account: a.accountId }, a.accountId)
    .then((r) => (r.ok ? ((r.data as { payload?: GmailBodyPart }).payload ?? null) : null));
  return judgeOwnerEmail({
    provider: 'gmail', kind: a.kind, placement: a.placement, from: a.from, deliveryRef: `gmail:${a.accountId}:${a.messageId}`,
    headers: async () => a.headers,
    newBody: async () => { const p = await payload(); return p ? extractOwnGmailText(p) : null; },
    isMeeting: async () => { const p = await payload(); return p === null || hasCalendarPart(p) || a.headers.some((h) => h.name.toLowerCase() === 'content-type' && /calendar/i.test(h.value)); },
  });
}

/** Outlook: the poll never carries the authentication headers, so ONE extra Graph read (made only when the From is an
 *  owner address) fetches the full header list, the message class and `uniqueBody` — the part the sender newly wrote. */
export function judgeOutlookOwnerEmail(a: { kind: 'agent' | 'user'; placement: OwnerEmailInput['placement']; fromAddress: string; messageId: string; accountId: string }): Promise<OwnerEmailOutcome> {
  type Got = { headers: MailHeader[] | null; body: string | null; meeting: boolean };
  let read: Promise<Got> | null = null;
  const once = (): Promise<Got> => read ??= (async () => {
    const r = await msGraphRead(`me/messages/${encodeURIComponent(a.messageId)}?$select=internetMessageHeaders,uniqueBody`, 'system', 'Outlook Watcher', 'outlook_owner_check', { messageId: a.messageId, account: a.accountId }, a.accountId);
    if (!r.ok) return { headers: null, body: null, meeting: true };
    const d = r.data as { '@odata.type'?: string; internetMessageHeaders?: MailHeader[]; uniqueBody?: { contentType?: string; content?: string } };
    const content = d.uniqueBody?.content;
    const headers = Array.isArray(d.internetMessageHeaders) ? d.internetMessageHeaders : null;
    const meeting = /eventmessage/i.test(d['@odata.type'] ?? '') || (headers ?? []).some((h) => ['content-class', 'content-type'].includes(h.name.toLowerCase()) && /calendar/i.test(h.value));
    return { headers, meeting, body: typeof content !== 'string' ? null : d.uniqueBody?.contentType?.toLowerCase() === 'html' ? stripHtmlTags(content) : content };
  })();
  return judgeOwnerEmail({ provider: 'outlook', kind: a.kind, placement: a.placement, from: a.fromAddress, deliveryRef: `outlook:${a.accountId}:${a.messageId}`, headers: async () => (await once()).headers, newBody: async () => (await once()).body, isMeeting: async () => (await once()).meeting });
}

/**
 * R24: when the owner's confirmed email carries a command or an approval ("yes <id>", "status", ...), run it through the same
 * handler a text reaches, and give back the note the agent reads about it (the agent speaks to the owner; the platform does not).
 * Empty when the email is not a confirmed owner email or its words are not a command.
 */
export async function ownerEmailCommandNote(ownerMail: OwnerEmailOutcome): Promise<string> {
  if (ownerMail.state !== 'confirmed' || !isOwnerCommandText(ownerMail.words)) return '';
  try {
    const { handleConfirmedOwnerEmailWords } = await import('./imessage-commands.js');
    const result = await handleConfirmedOwnerEmailWords(ownerMail.words);
    return result ? `\n\n[Dojo: the owner's words in this email were a command or an approval, and the Dojo carried it out as it does for a text. Its result: "${result}" Tell the owner in your own words.]` : '';
  } catch { return ''; }
}
