// v3.5 DONE IS MEASURED: the Gmail counter behind a task's measure (work/measure.ts).
//
// It reads the mailbox the agent's own `gmail_search` / `user_gmail_search` would read — the same
// kind (the agent's account or the user's) and the same account resolver — so the count the
// engine holds the task to is the count the agent would see if it ran the query itself.
import { googleRead } from './client.js';
import { resolveGoogleAccountForRead } from './accounts.js';
import type { GoogleAccountKind } from './accounts.js';

const GMAIL_BASE = 'https://gmail.googleapis.com/gmail/v1/users/me';
const PAGE = 500;   // Gmail's documented maximum for messages.list

/** Counts every message the query matches: ids only, every page, no per-message fetch. */
export async function countGmailSearch(
  args: { query: string; account?: string },
  agentId: string,
  agentName: string,
  kind: GoogleAccountKind = 'agent',
): Promise<{ ok: true; count: number } | { ok: false; error: string }> {
  const resolved = resolveGoogleAccountForRead(kind, args.account);
  if ('error' in resolved) return { ok: false, error: resolved.error };
  const slot = resolved.account.id;
  let count = 0;
  let pageToken: string | undefined;
  do {
    const url = `${GMAIL_BASE}/messages?q=${encodeURIComponent(args.query)}&maxResults=${PAGE}&fields=${encodeURIComponent('messages/id,nextPageToken')}${pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : ''}`;
    const r = await googleRead(url, agentId, agentName, 'measure_count', { query: args.query, pageToken }, slot);
    if (!r.ok) return { ok: false, error: r.error ?? 'unknown error' };
    const data = r.data as { messages?: Array<{ id: string }>; nextPageToken?: string } | null;
    count += data?.messages?.length ?? 0;
    pageToken = data?.nextPageToken;
  } while (pageToken);
  return { ok: true, count };
}
