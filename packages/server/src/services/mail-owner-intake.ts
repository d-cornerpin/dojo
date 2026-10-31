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
  /** The watched mailbox's kind. Only the agent's own mailbox can receive the owner's words. */
  kind: 'agent' | 'user';
  /** The From header value (Gmail) or the bare From address (Outlook). */
  from: string;
  /** Every header the provider holds, TOPMOST FIRST; null when it would not give them. Called only for a message whose From is an owner address. */
  headers: () => Promise<MailHeader[] | null>;
  /** The message's plain text with the quoted thread cut away where the provider can do it; null when unavailable. */
  newBody: () => Promise<string | null>;
}

/** True the first time an owner email's Message-ID is seen, recorded in the same breath; false ever after. */
function firstSighting(messageId: string): boolean {
  try {
    return getDb().prepare(`INSERT OR IGNORE INTO config (key, value, updated_at) VALUES (?, ?, datetime('now'))`).run(`owner_mail_seen:${messageId.replace(/^<|>$/g, '')}`, new Date().toISOString()).changes === 1;
  } catch { return false; }
}

const NOT_ABOUT_OWNER = new Set(['no_owner_addresses', 'from_not_single', 'from_not_owner']);

export async function judgeOwnerEmail(i: OwnerEmailInput): Promise<OwnerEmailOutcome> {
  if (i.kind !== 'agent') return { state: 'none' };
  const ownerAddresses = ownerMailboxes().map((m) => m.address);
  // Is the From an owner address at all? (No headers needed to answer that, so no extra fetch otherwise.)
  const claim = ownerEmailVerdict({ provider: i.provider, from: i.from, headers: [], ownerAddresses });
  if (claim.verdict === 'unconfirmed' && NOT_ABOUT_OWNER.has(claim.reason)) return { state: 'none' };
  if (i.placement === 'neither') return { state: 'unconfirmed' };
  const headers = await i.headers().catch(() => null);
  // The provider's list must show the From it judged: none at all is a list it did not really give.
  if (!headers || !headers.some((h) => h.name.toLowerCase() === 'from')) return { state: 'unconfirmed' };
  // Mail the platform itself sent (from the owner's own mailbox, send-as) is never the owner speaking, whatever its DMARC says.
  if (isPlatformSent(headers)) return { state: 'none' };
  if (ownerEmailVerdict({ provider: i.provider, from: i.from, headers, ownerAddresses }).verdict !== 'owner') return { state: 'unconfirmed' };
  // A genuine owner email delivered again (a replay) carries the same Message-ID: each id counts once, and a message with none never.
  const messageId = headers.find((h) => h.name.toLowerCase() === 'message-id')?.value.trim().toLowerCase();
  if (!messageId || !firstSighting(messageId)) return { state: 'unconfirmed' };
  const body = await i.newBody().catch(() => null);
  return { state: 'confirmed', words: body === null ? '' : newTextOf(body) };
}

/** Gmail: the headers the watcher already fetched are the provider's, in message order; the body is read only for a confirmed owner. */
export function judgeGmailOwnerEmail(a: { kind: 'agent' | 'user'; placement: OwnerEmailInput['placement']; from: string; headers: MailHeader[]; messageId: string; accountId: string }): Promise<OwnerEmailOutcome> {
  return judgeOwnerEmail({
    provider: 'gmail', kind: a.kind, placement: a.placement, from: a.from,
    headers: async () => a.headers,
    newBody: async () => {
      const r = await googleRead(`https://gmail.googleapis.com/gmail/v1/users/me/messages/${encodeURIComponent(a.messageId)}?format=full`, 'system', 'Gmail Watcher', 'gmail_read', { messageId: a.messageId, account: a.accountId }, a.accountId);
      return r.ok ? extractOwnGmailText((r.data as { payload?: GmailBodyPart }).payload) : null;
    },
  });
}

/** Outlook: the poll never carries the authentication headers, so ONE extra Graph read (made only when the From is an
 *  owner address) fetches the full header list and `uniqueBody` — the part of the email the sender newly wrote. */
export function judgeOutlookOwnerEmail(a: { kind: 'agent' | 'user'; placement: OwnerEmailInput['placement']; fromAddress: string; messageId: string; accountId: string }): Promise<OwnerEmailOutcome> {
  let read: Promise<{ headers: MailHeader[] | null; body: string | null }> | null = null;
  const once = (): Promise<{ headers: MailHeader[] | null; body: string | null }> => read ??= (async () => {
    const r = await msGraphRead(`me/messages/${encodeURIComponent(a.messageId)}?$select=internetMessageHeaders,uniqueBody`, 'system', 'Outlook Watcher', 'outlook_owner_check', { messageId: a.messageId, account: a.accountId }, a.accountId);
    if (!r.ok) return { headers: null, body: null };
    const d = r.data as { internetMessageHeaders?: MailHeader[]; uniqueBody?: { contentType?: string; content?: string } };
    const content = d.uniqueBody?.content;
    return {
      headers: Array.isArray(d.internetMessageHeaders) ? d.internetMessageHeaders : null,
      body: typeof content !== 'string' ? null : d.uniqueBody?.contentType?.toLowerCase() === 'html' ? stripHtmlTags(content) : content,
    };
  })();
  return judgeOwnerEmail({ provider: 'outlook', kind: a.kind, placement: a.placement, from: a.fromAddress, headers: async () => (await once()).headers, newBody: async () => (await once()).body });
}
