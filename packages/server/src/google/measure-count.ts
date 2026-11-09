// v3.5 DONE IS MEASURED: the Gmail counter behind a task's measure (work/measure.ts).
//
// It reads the mailbox the agent's own `gmail_search` / `user_gmail_search` would read — the same
// kind (the agent's account or the user's) and the same account resolver — so the count the
// engine holds the task to is the count the agent would see if it ran the query itself.
import { googleSilentFetch } from './client.js';
import { resolveGoogleAccountForRead } from './accounts.js';
import { logGoogleActivity } from './activity-log.js';
import { GMAIL_BASE } from './gmail-search.js';
import type { GoogleAccountKind } from './accounts.js';

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
  let pages = 0;
  let pageToken: string | undefined;
  let lastEndpoint = '';
  let failure: string | undefined;
  do {
    const url = `${GMAIL_BASE}/messages?q=${encodeURIComponent(args.query)}&maxResults=${PAGE}&fields=${encodeURIComponent('messages/id,nextPageToken')}${pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : ''}`;
    const r = await googleSilentFetch('GET', url, undefined, undefined, slot, agentId);
    pages += 1;
    lastEndpoint = r.apiEndpoint;
    if (!r.ok) {
      failure = r.error ?? 'unknown error';
      break;
    }
    const data = r.data as { messages?: Array<{ id: string }>; nextPageToken?: string } | null;
    count += data?.messages?.length ?? 0;
    pageToken = data?.nextPageToken;
  } while (pageToken);
  logGoogleActivity({
    agentId, agentName, action: 'measure_count', actionType: 'read',
    details: JSON.stringify({ query: args.query, pages, count, account: slot }),
    gwsCommand: lastEndpoint,
    success: failure === undefined,
    error: failure,
  });
  if (failure !== undefined) return { ok: false, error: failure };
  return { ok: true, count };
}
