// Gmail's side of the one mail watcher (`mail-watcher.ts`): the inbox ids are listed by query, page by page (Gmail
// lists newest first), and each new mail's headers are read with a second call.

import { googleRead } from '../google/client.js';
import { GMAIL_BASE } from '../google/gmail-search.js';
import { listGoogleAccountViews } from '../google/auth.js';
import { gmailAddressingFacts, gmailSnippetText } from './mail-inbound-facts.js';
import { judgeGmailOwnerEmail } from './mail-owner-intake.js';
import { MailWatcher } from './mail-watcher.js';
import type { WatcherStatus } from './watcher-status.js';

// Ids only, so pages are large: every id is listed before the oldest mails are read.
const PAGE_SIZE = 500;
const HEADERS = ['From', 'Subject', 'Date', 'To', 'Cc', 'Authentication-Results', 'Message-ID', 'X-Platform-Send-Id'];

const gmail = new MailWatcher<{ id: string; threadId?: string }>({
  name: 'gmail',
  company: 'Google',
  newestFirst: true,
  views: () => listGoogleAccountViews(),
  async list(view, since, next) {
    const query = `in:inbox after:${Math.floor(since.getTime() / 1000)}`;
    const url = `${GMAIL_BASE}/messages?q=${encodeURIComponent(query)}&maxResults=${PAGE_SIZE}${next ? `&pageToken=${encodeURIComponent(next)}` : ''}`;
    const r = await googleRead(url, 'system', 'Gmail Watcher', 'gmail_inbox_poll', { query, account: view.id }, view.id);
    if (!r.ok) return { ok: false, error: r.error ?? 'Unknown poll error' };
    const data = r.data as { messages?: Array<{ id: string; threadId?: string }>; nextPageToken?: string } | null;
    return { ok: true, refs: data?.messages ?? [], next: data?.nextPageToken ?? null };
  },
  async read(view, ref) {
    const url = `${GMAIL_BASE}/messages/${ref.id}?format=metadata${HEADERS.map((h) => `&metadataHeaders=${h}`).join('')}`;
    const r = await googleRead(url, 'system', 'Gmail Watcher', 'gmail_read', { messageId: ref.id, account: view.id }, view.id);
    if (!r.ok) return null;
    const msg = r.data as { snippet?: string; internalDate?: string; payload?: { headers?: Array<{ name: string; value: string }> } } | null;
    const headers = msg?.payload?.headers ?? [];
    const header = (name: string): string | undefined => headers.find((h) => h.name === name)?.value;
    const from = header('From') ?? 'Unknown sender';
    // Only this mailbox's own address places the copy on To or Cc (the owner-mail blind-copy check reads it).
    const addressing = gmailAddressingFacts(headers, view.email ? [view.email] : []);
    return {
      id: ref.id,
      threadRoot: ref.threadId ?? ref.id,
      from,
      fromAddr: (from.match(/<([^>]+)>/) ?? from.match(/(\S+@\S+)/))?.[1]?.toLowerCase() ?? '',
      subject: header('Subject') ?? '(no subject)',
      date: header('Date') ?? '',
      snippet: gmailSnippetText(msg?.snippet),
      addressing,
      receivedAt: Number(msg?.internalDate),
      owner: () => judgeGmailOwnerEmail({ kind: view.kind, placement: addressing.placement, from, headers, messageId: ref.id, accountId: view.id }),
    };
  },
});

export const startGmailWatcher = (): void => gmail.start();
export const stopGmailWatcher = (): void => gmail.stop();
export const getGmailWatcherStatus = (): WatcherStatus => gmail.status();
export const markGmailWatchBaselineNow = (accountId: string): void => gmail.markBaselineNow(accountId);
