// ════════════════════════════════════════
// Gmail search: one page of results, with the token for the next (v3.5, B3).
//
// `messages.list` returns at most 500 ids a page and a `nextPageToken` when more exist. A worker
// sweeping a mailbox needs to walk past the first page, so `page_token` goes in and the next one
// comes out as a line the model can copy. The per-message metadata fetch is unchanged.
// (Moved out of tools-read.ts, which is size-pinned; tools-read re-exports what others import.)
// ════════════════════════════════════════

import { googleRead } from './client.js';
import { formatTimeForAgent, parseFlexibleTime } from '../services/format-time.js';

export const GMAIL_BASE = 'https://gmail.googleapis.com/gmail/v1/users/me';

/**
 * Format an email Date header for agent consumption. RFC 2822 headers
 * like "Wed, 20 May 2026 19:00:00 +0000" have an offset, so parsing is
 * unambiguous — but the format differs from every other tool. Route
 * through formatTimeForAgent so the agent sees the same dual-format
 * string everywhere. Empty input passes through as empty.
 */
export function fmtEmailDate(rfc2822: string): string {
  if (!rfc2822) return '';
  const parsed = parseFlexibleTime(rfc2822);
  return parsed ? formatTimeForAgent(parsed) : rfc2822;
}

/** Normalized email row (metadata only) for search rendering. */
export interface GoogleMailFetchItem {
  id: string;
  from: string;
  to: string;
  subject: string;
  dateDisplay: string;
  dateSortMs: number;
  snippet: string;
  /** Read-state is not fetched by Gmail search; left undefined (unknown). */
  read: boolean | undefined;
}

/** Search one account's Gmail. `total` is the raw match count on THIS page (pre-detail-fetch). */
export async function searchMailForAccount(
  accountId: string,
  query: string,
  maxResults: number,
  agentId: string,
  agentName: string,
  pageToken?: string,
): Promise<{ ok: true; total: number; items: GoogleMailFetchItem[]; nextPageToken?: string } | { ok: false; error: string }> {
  const listUrl = `${GMAIL_BASE}/messages?q=${encodeURIComponent(query)}&maxResults=${maxResults}` +
    (pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : '');
  const result = await googleRead(listUrl, agentId, agentName, 'gmail_search', { query, maxResults, pageToken }, accountId);
  if (!result.ok) return { ok: false, error: result.error ?? 'unknown error' };

  const data = result.data as { messages?: Array<{ id: string; threadId: string }>; nextPageToken?: string };
  if (!data?.messages || data.messages.length === 0) return { ok: true, total: 0, items: [] };

  const items: GoogleMailFetchItem[] = [];
  for (const msg of data.messages.slice(0, maxResults)) {
    const detailUrl = `${GMAIL_BASE}/messages/${msg.id}?format=metadata&metadataHeaders=From&metadataHeaders=To&metadataHeaders=Subject&metadataHeaders=Date`;
    const detail = await googleRead(detailUrl, agentId, agentName, 'gmail_read', { messageId: msg.id }, accountId);
    if (detail.ok) {
      const msgData = detail.data as { id: string; snippet: string; payload?: { headers?: Array<{ name: string; value: string }> } };
      const headers = msgData?.payload?.headers ?? [];
      const from = headers.find(h => h.name === 'From')?.value ?? '';
      const to = headers.find(h => h.name === 'To')?.value ?? '';
      const subject = headers.find(h => h.name === 'Subject')?.value ?? '(no subject)';
      const date = headers.find(h => h.name === 'Date')?.value ?? '';
      const snippet = msgData?.snippet ?? '';
      const parsed = date ? parseFlexibleTime(date) : null;
      items.push({ id: msg.id, from, to, subject, dateDisplay: fmtEmailDate(date), dateSortMs: parsed ? parsed.getTime() : 0, snippet, read: undefined });
    }
  }
  return { ok: true, total: data.messages.length, items, nextPageToken: data.nextPageToken || undefined };
}

/** The `gmail_search` tool body. */
export async function executeGmailSearch(
  args: Record<string, unknown>,
  slot: string,
  acctLabel: string | null,
  agentId: string,
  agentName: string,
): Promise<string> {
  const query = args.query as string;
  const maxResults = (args.max_results as number) ?? 10;
  const verbose = args.verbose as boolean | undefined;
  const pageToken = typeof args.page_token === 'string' && args.page_token ? args.page_token : undefined;

  const fetched = await searchMailForAccount(slot, query, maxResults, agentId, agentName, pageToken);
  if (!fetched.ok) return `Error searching Gmail: ${fetched.error}`;

  // F4 data floor: the SAME query run against every OTHER connected mailbox,
  // counts only, so a single-mailbox search never reads as the whole picture.
  const { otherMailboxesCountSection } = await import('../tools/unified-read.js');
  const others = await otherMailboxesCountSection({ provider: 'google', accountId: slot }, query, 0, agentId, agentName);

  const inAcct = acctLabel ? ` in ${acctLabel}` : '';
  if (fetched.total === 0) return `No emails found matching that query${inAcct}.` + others;

  const details: string[] = fetched.items.map(it => {
    if (verbose) {
      return `ID: ${it.id}\nFrom: ${it.from}\nTo: ${it.to}\nSubject: ${it.subject}\nDate: ${it.dateDisplay}\nSnippet: ${it.snippet}\n`;
    }
    // Compact: one line per email — drop To, keep snippet capped to 200ch.
    const shortSnippet = it.snippet.length > 200 ? it.snippet.slice(0, 200) + '…' : it.snippet;
    return `- ${it.dateDisplay} | ${it.from} — ${it.subject}\n  ID: ${it.id} | ${shortSnippet}`;
  });

  if (details.length === 0) return `Found ${fetched.total} email(s)${inAcct} but could not fetch details.` + others;
  const paging = fetched.nextPageToken
    ? `\n\nnext_page_token: ${fetched.nextPageToken}\nMore results exist: re-call with page_token="${fetched.nextPageToken}"`
    : '';
  const header = `Found ${fetched.total} email(s)${inAcct}:\n\n${details.join(verbose ? '\n---\n' : '\n')}${paging}`;
  if (verbose) return header + others;
  return `${header}\n\n${details.length} compact result${details.length === 1 ? '' : 's'} shown. For full body of one: gmail_read(message_id=<id>). For To/CC + full snippet on every result: re-call gmail_search with verbose=true.${others}`;
}
