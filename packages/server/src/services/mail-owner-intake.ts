// Is this email the owner speaking? The one place either mail watcher asks.
// The owner is the connected 'user' accounts' addresses (`owner-mailboxes.ts`, read each call). An email counts
// ONLY when the provider's DMARC result confirms it (`mail-owner-verdict.ts`, never the body) AND the single From
// is one of them. Owner words are the NEW text only (`mail-quoted-text.ts`) and ride the inbound meta as
// `ownerWords`, which `tracker/owner-words.ts` reads, never the notice or preview. Fail closed.

import { getDb } from '../db/connection.js';
import { ownerMailboxes } from './owner-mailboxes.js';
import { ownerEmailVerdict, type MailHeader } from './mail-owner-verdict.js';
import { isOwnerCommandText } from './owner-command-words.js';
import { newTextOf } from './mail-quoted-text.js';
import { stripHtmlTags } from '../agent/html-text.js';
import { extractOwnGmailText, type GmailBodyPart } from '../google/gmail-body.js';
import { googleRead } from '../google/client.js';
import { msGraphRead } from '../microsoft/client.js';
import { forgetOldMailRecords, isPlatformSent } from './platform-sends.js';
import type { OwnerEmailNotice } from '../tools/inbound-fences.js';

/** `none`: the From is not an owner address (or the mail is in the owner's own inbox). `reread`: this delivery was
 *  judged before, so its command already ran. */
export type OwnerEmailOutcome = { state: 'none' } | OwnerEmailNotice | { state: 'confirmed'; words: string; reread: true };

export interface OwnerEmailInput {
  provider: 'gmail' | 'outlook';
  /** Where the agent's address sits; an owner email counts only on To or Cc, never a blind copy. */
  placement: 'to' | 'cc' | 'neither';
  /** The provider's id for THIS delivery: tells a re-read from a replay with the same Message-ID. */
  deliveryRef: string;
  kind: 'agent' | 'user';
  from: string;
  /** Every header the provider holds, TOPMOST FIRST (the verdict trusts only the top auth result); null if none. */
  headers: () => Promise<MailHeader[] | null>;
  newBody: () => Promise<string | null>;
  /** A meeting item (invite, response, cancellation, calendar part) is never the owner speaking. Unknown = yes. */
  isMeeting: () => Promise<boolean>;
}

// `first` if this delivery first used the Message-ID, `reread` if this same delivery used it before, else
// `seen_before`; fail closed.
function firstSighting(messageId: string, deliveryRef: string): 'first' | 'reread' | 'seen_before' | 'failed' {
  try {
    const key = `owner_mail_seen:${messageId.replace(/^<|>$/g, '')}`;
    const db = getDb();
    forgetOldMailRecords('owner_mail_seen:');
    if (db.prepare(`INSERT OR IGNORE INTO config (key, value, updated_at) VALUES (?, ?, datetime('now'))`).run(key, deliveryRef).changes === 1) return 'first';
    return (db.prepare('SELECT value FROM config WHERE key = ?').get(key) as { value: string } | undefined)?.value === deliveryRef ? 'reread' : 'seen_before';
  } catch { return 'failed'; }
}

const NOT_ABOUT_OWNER = new Set(['no_owner_addresses', 'from_not_single', 'from_not_owner']);

export async function judgeOwnerEmail(i: OwnerEmailInput): Promise<OwnerEmailOutcome> {
  if (i.kind !== 'agent') return { state: 'none' };
  const ownerAddresses = ownerMailboxes().map((m) => m.address);
  const claim = ownerEmailVerdict({ provider: i.provider, from: i.from, headers: [], ownerAddresses });
  if (claim.verdict === 'unconfirmed' && NOT_ABOUT_OWNER.has(claim.reason)) return { state: 'none' };
  if (i.placement === 'neither') return { state: 'unconfirmed', reason: 'bcc' };
  const headers = await i.headers().catch(() => null);
  // The provider's list must show the From it judged: none at all is a list it did not really give.
  if (!headers || !headers.some((h) => h.name.toLowerCase() === 'from')) return { state: 'unconfirmed', reason: 'check_failed' };
  // Mail the platform itself sent (from the owner's own mailbox, send-as) is never the owner speaking, whatever its DMARC says.
  if (isPlatformSent(headers)) return { state: 'none' };
  if (ownerEmailVerdict({ provider: i.provider, from: i.from, headers, ownerAddresses }).verdict !== 'owner') return { state: 'unconfirmed', reason: 'check_failed' };
  if (await i.isMeeting().catch(() => true)) return { state: 'none' };
  const messageId = headers.find((h) => h.name.toLowerCase() === 'message-id')?.value.trim().toLowerCase();
  if (!messageId) return { state: 'unconfirmed', reason: 'no_message_id' };
  const sighting = firstSighting(messageId, i.deliveryRef);
  if (sighting === 'seen_before' || sighting === 'failed') return { state: 'unconfirmed', reason: sighting === 'seen_before' ? 'seen_before' : 'check_failed' };
  const body = await i.newBody().catch(() => null);
  const words = body === null ? '' : newTextOf(body);
  return sighting === 'reread' ? { state: 'confirmed', words, reread: true } : { state: 'confirmed', words };
}

function hasCalendarPart(part: GmailBodyPart | undefined): boolean {
  if (!part) return false;
  const type = (part.mimeType ?? '').toLowerCase();
  return type.includes('calendar') || type === 'application/ics' || (part.parts ?? []).some(hasCalendarPart);
}

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

/** Outlook: one extra Graph read, only for an owner From, fetches the headers, class and `uniqueBody`. */
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

/** Runs a confirmed owner email's command or approval through the text handler; returns the agent's note. */
export async function ownerEmailCommandNote(ownerMail: OwnerEmailOutcome): Promise<string> {
  if (ownerMail.state !== 'confirmed' || 'reread' in ownerMail || !isOwnerCommandText(ownerMail.words)) return '';
  try {
    const { handleConfirmedOwnerEmailWords } = await import('./imessage-commands.js');
    const result = await handleConfirmedOwnerEmailWords(ownerMail.words);
    return result ? `\n\n[Dojo: the owner's words in this email were a command or an approval, and the Dojo carried it out as it does for a text. Its result: "${result}" Tell the owner in your own words.]` : '';
  } catch { return ''; }
}
