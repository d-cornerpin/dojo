// Outlook's side of the one mail watcher (`mail-watcher.ts`): one Graph listing, oldest first and page by page,
// carries every field.

import { msGraphRead } from '../microsoft/client.js';
import { listMicrosoftAccountViews } from '../microsoft/auth.js';
import { judgeOutlookOwnerEmail } from './mail-owner-intake.js';
import { outlookAddressingFacts } from './mail-inbound-facts.js';
import { MailWatcher } from './mail-watcher.js';
import type { WatcherStatus } from './watcher-status.js';

const PAGE_SIZE = 50;

type GraphAddress = { emailAddress?: { name?: string; address?: string } };
interface GraphMail {
  id: string;
  from?: GraphAddress;
  subject?: string;
  receivedDateTime?: string;
  bodyPreview?: string;
  conversationId?: string;
  toRecipients?: GraphAddress[];
  ccRecipients?: GraphAddress[];
}

const outlook = new MailWatcher<GraphMail>({
  name: 'outlook',
  company: 'Microsoft',
  newestFirst: false,
  views: () => listMicrosoftAccountViews(),
  async list(view, since, next) {
    const filter = `receivedDateTime gt ${since.toISOString()}`;
    const endpoint = next ?? `me/mailFolders/inbox/messages?$top=${PAGE_SIZE}&$filter=${encodeURIComponent(filter)}&$select=id,from,subject,receivedDateTime,bodyPreview,isRead,conversationId,toRecipients,ccRecipients&$orderby=receivedDateTime asc`;
    const r = await msGraphRead(endpoint, 'system', 'Outlook Watcher', 'outlook_inbox_poll', { filter, account: view.id }, view.id);
    if (!r.ok) return { ok: false, error: r.error ?? 'Unknown poll error' };
    const data = r.data as { value?: GraphMail[]; '@odata.nextLink'?: string } | null;
    return { ok: true, refs: data?.value ?? [], next: data?.['@odata.nextLink'] ?? null };
  },
  async read(view, msg) {
    const fromName = msg.from?.emailAddress?.name ?? '';
    const fromAddress = msg.from?.emailAddress?.address ?? 'Unknown sender';
    const date = msg.receivedDateTime ?? '';
    // Only this mailbox's own address places the copy on To or Cc; the Graph listing has no Authentication-Results.
    const addressing = outlookAddressingFacts(msg, view.email ? [view.email] : []);
    return {
      id: msg.id,
      threadRoot: msg.conversationId ?? msg.id,
      from: fromName ? `${fromName} <${fromAddress}>` : fromAddress,
      fromAddr: fromAddress.includes('@') ? fromAddress.toLowerCase() : '',
      subject: msg.subject ?? '(no subject)',
      date,
      snippet: msg.bodyPreview ?? '',
      addressing,
      receivedAt: Date.parse(date),
      owner: () => judgeOutlookOwnerEmail({ kind: view.kind, placement: addressing.placement, fromAddress, messageId: msg.id, accountId: view.id }),
    };
  },
});

export const startOutlookWatcher = (): void => outlook.start();
export const stopOutlookWatcher = (): void => outlook.stop();
export const getOutlookWatcherStatus = (): WatcherStatus => outlook.status();
export const markOutlookWatchBaselineNow = (accountId: string): void => outlook.markBaselineNow(accountId);
