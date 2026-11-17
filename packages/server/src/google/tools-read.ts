// Google Workspace READ tools (native REST API). Available to: primary, trainer, ronin, apprentice.
// Not available to: PM agent.

import { docBlocksToText, type DocBlock } from './docs-text.js';
import type { ToolDefinition } from '../agent/tools/types.js';
import { applyTextPagination } from '../agent/tools/pagination.js';
import { outsideSpan } from '../tools/external-content.js';
import { googleRead } from './client.js';
import { firstTabRange } from './sheets-first-tab.js';
import { extractGmailBodyText } from './gmail-body.js';
import { downloadableAttachments, type GmailMessagePart } from './gmail-attachments.js';
import { driveSearchQuery, withoutQuotedValues } from './drive-query.js';
import { formatTimeForAgent, parseFlexibleTime } from '../services/format-time.js';
import { toRfc3339WithOffset } from '../services/rfc3339-offset.js';
import { executeGmailSearch, fmtEmailDate, GMAIL_BASE } from './gmail-search.js';
import { gmailSnippetText } from '../services/mail-inbound-facts.js';
export { searchMailForAccount, type GoogleMailFetchItem } from './gmail-search.js';

const CALENDAR_BASE = 'https://www.googleapis.com/calendar/v3';
const DRIVE_BASE = 'https://www.googleapis.com/drive/v3';
const DOCS_BASE = 'https://docs.googleapis.com/v1/documents';
const SHEETS_BASE = 'https://sheets.googleapis.com/v4/spreadsheets';

// Google omits `summary` for an event with no title (a quick block, a private slot
// seen through a shared calendar); rendering it directly prints "undefined".
const NO_TITLE = '(no title)';
function eventTitle(summary: string | undefined | null): string {
  return typeof summary === 'string' && summary.trim() !== '' ? summary : NO_TITLE;
}

// With `includeTabsContent=true` every tab's content sits at tabs[].documentTab.body.content, and a
// tab may nest childTabs (same shape). Depth-first: a tab, then its children. A document with a
// single tab keeps the bare output; with more, each tab's text is introduced by its title so a
// multi-tab document never reads as only its first tab. Returns undefined when the response has no
// tabs, so the caller falls back to the legacy `body`.
interface DocTab {
  tabProperties?: { title?: string };
  documentTab?: { body?: { content?: DocBlock[] } };
  childTabs?: DocTab[];
}

function docTabsToText(tabs: DocTab[] | undefined): string | undefined {
  if (!tabs || tabs.length === 0) return undefined;
  const flat: DocTab[] = [];
  const walk = (list: DocTab[]) => {
    for (const tab of list) {
      flat.push(tab);
      if (tab.childTabs?.length) walk(tab.childTabs);
    }
  };
  walk(tabs);
  if (flat.length === 1) return docBlocksToText(flat[0].documentTab?.body?.content);
  return flat.map((tab) => {
    const title = tab.tabProperties?.title;
    const name = typeof title === 'string' && title.trim() !== '' ? title : 'Untitled tab';
    return `=== Tab: ${name} ===\n${docBlocksToText(tab.documentTab?.body?.content)}`;
  }).join('');
}

// ── Tool definitions ──

export const googleReadToolDefinitions: ToolDefinition[] = [
  {
    name: 'gmail_search',
    description: 'Search Gmail. Default returns one compact line per email (date | sender — subject + 200-char snippet + ID). For To/CC + full snippet on every result, pass verbose=true; for the full body of ONE email, use gmail_read(message_id). When more results exist the reply ends with next_page_token: pass it back as page_token (same query) to get the next page; keep paging until no next_page_token is printed.',
    effects: [],
    input_schema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: "Gmail search query (e.g., 'from:john@example.com after:2026/03/01')" },
        max_results: { type: 'number', description: 'Maximum number of results (default: 10; 500 is the most Gmail returns in one page)' },
        page_token: { type: 'string', description: 'The next_page_token from a previous result, to get the next page of the same query' },
        verbose: { type: 'boolean', description: 'If true, include To/CC and the full snippet per result. Default false (one line per result).' },
      },
      required: ['query'],
    },
    scale: { pages: { arg: 'max_results', pageSize: 500, tokenArg: 'page_token' }, note: 'one call returns up to {pageSize} results (max_results); page_token continues the same query' },   // 500: Gmail page maximum
    concurrency: 'safe',
    maxResultTokens: 3000,
  },
  {
    name: 'gmail_read',
    description:
      'Read a specific email by message ID. Returns sender, recipients, subject, date, plain-text body, and attachment list (name + ID). The body is paginated: defaults to first ~12K chars (~3K tokens). For long emails, use `offset` + `limit`. To download an attachment, use gmail_read_attachment with the attachment ID.',
    effects: [],
    input_schema: {
      type: 'object',
      properties: {
        message_id: { type: 'string', description: 'Gmail message ID (from gmail_search results)' },
        offset: { type: 'number', description: 'Body character offset to start from (default 0). Use the value from the previous call\'s pagination trailer.' },
        limit: { type: 'number', description: 'Body characters to return (default 12000 ≈ 3K tokens). Don\'t exceed 16000 — engine cap will truncate.' },
      },
      required: ['message_id'],
    },
    concurrency: 'safe',
    maxResultTokens: 4000,
  },
  {
    name: 'gmail_list_attachments',
    description:
      'List attachments on a Gmail message — name, MIME type, size, and attachment ID for each. Use gmail_read_attachment with one of these IDs to download to local disk.',
    effects: [],
    input_schema: {
      type: 'object',
      properties: {
        message_id: { type: 'string', description: 'Gmail message ID (from gmail_search or gmail_inbox results)' },
      },
      required: ['message_id'],
    },
    concurrency: 'safe',
    maxResultTokens: 1500,
  },
  {
    name: 'gmail_inbox',
    description: "Show recent inbox messages. Quick way to see what's new without a specific search.",
    effects: [],
    input_schema: {
      type: 'object',
      properties: {
        max_results: { type: 'number', description: 'How many recent messages to show (default: 10)' },
        unread_only: { type: 'boolean', description: 'Only show unread messages (default: false)' },
      },
      required: [],
    },
    concurrency: 'safe',
    maxResultTokens: 3000,
  },
  {
    name: 'calendar_agenda',
    description: "[DEFAULT for any 'my day / my schedule / what's coming up' ask] Merged agenda across EVERY connected calendar (agent + owner, Google + Microsoft), each item labeled with its source. Use calendar_agenda_ms / user_calendar_agenda / user_calendar_agenda_ms only when the user names one specific account. When a user asks about a specific local day (e.g. \"events for Wednesday\"), pass start_date + timezone so the window aligns to local midnight rather than UTC. The `account` parameter is IGNORED on this merged view (the provider-specific variants take it).",
    effects: [],
    input_schema: {
      type: 'object',
      properties: {
        days: { type: 'number', description: 'How many days to span (1 = a single day, 7 = a week, default 1).' },
        timezone: { type: 'string', description: 'IANA timezone (e.g. "America/Los_Angeles"). Defaults to the system timezone. When set, the window snaps to local midnight in this timezone.' },
        start_date: { type: 'string', description: 'Anchor the window to a specific local date in YYYY-MM-DD (interpreted in `timezone`). Use this when the user asks about a specific day like "Wednesday" or "tomorrow" — compute the date, then pass it here. Omit to default to "today" in the given timezone.' },
        calendar_id: { type: 'string', description: 'Ignored on the merged view. To read a single shared calendar by ID, use the provider-specific variant (user_calendar_agenda / calendar_agenda_ms).' },
      },
      required: [],
    },
    concurrency: 'safe',
    maxResultTokens: 6000,
  },
  {
    name: 'calendar_search',
    description: 'Search calendar events by text query. Defaults to your primary calendar; pass calendar_id to search a shared one. Pass start_date + timezone when constraining to a specific local day.',
    effects: [],
    input_schema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Search text to find in event titles and descriptions' },
        days_ahead: { type: 'number', description: 'How far ahead to search in days (default: 30)' },
        timezone: { type: 'string', description: 'IANA timezone for the search window (e.g. "America/Los_Angeles"). Defaults to system timezone.' },
        start_date: { type: 'string', description: 'Anchor the window to a specific local date in YYYY-MM-DD. Defaults to "today" in the given timezone.' },
        calendar_id: { type: 'string', description: 'Calendar ID. Defaults to "primary".' },
      },
      required: ['query'],
    },
    concurrency: 'safe',
    maxResultTokens: 2000,
  },
  {
    name: 'calendar_list',
    description: 'List all Google calendars you have access to, including shared calendars. Returns each calendar with its ID, name, and your access level (owner / writer / reader / freeBusyReader). Use the returned IDs with calendar_agenda, calendar_search, calendar_create, etc., to operate on a specific calendar.',
    effects: [],
    input_schema: {
      type: 'object',
      properties: {},
      required: [],
    },
    concurrency: 'safe',
    maxResultTokens: 2000,
  },
  {
    name: 'drive_list',
    advertisedNotDeclared: { trashed: "a Google Drive API query term (`trashed = true`) the description tells the model to put inside the `query` string, not a parameter of this tool" },
    description: 'List files in Google Drive. Files in the Trash are left out; add trashed = true to the query to search the Trash. Default returns one compact line per file (name + size + short type + id + date). For full mime types and timestamps on every result, pass verbose=true; for the content of ONE file, use drive_read(file_id).',
    effects: [],
    input_schema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: "Drive search query. Quote every value with single quotes, e.g. \"name contains 'report'\", \"mimeType = 'application/pdf'\", \"fullText contains 'budget'\". A bare word or phrase (e.g. report) searches file names and contents." },
        folder_id: { type: 'string', description: 'List files in a specific folder' },
        max_results: { type: 'number', description: 'Maximum results (default: 20)' },
        verbose: { type: 'boolean', description: 'If true, include full mime type and full timestamps per file. Default false (compact rows).' },
      },
      required: [],
    },
    concurrency: 'safe',
    maxResultTokens: 3000,
  },
  {
    name: 'drive_read',
    description: 'Read the content of a Google Drive file (Docs, Sheets, or text files). Returns text content paginated by character — defaults to first ~16K chars (~4K tokens). For long files, use `offset` + `limit` per the pagination trailer.',
    effects: [],
    input_schema: {
      type: 'object',
      properties: {
        file_id: { type: 'string', description: 'Google Drive file ID (from drive_list results)' },
        offset: { type: 'number', description: 'Character offset to start from (default 0). Use the value from the previous call\'s pagination trailer.' },
        limit: { type: 'number', description: 'Characters to return (default 16000 ≈ 4K tokens). Don\'t exceed 20000.' },
      },
      required: ['file_id'],
    },
    concurrency: 'safe',
    maxResultTokens: 5000,
  },
  {
    name: 'docs_read',
    description: 'Read the content of a Google Doc. Defaults to first ~16K chars (~4K tokens). For long docs, use `offset` + `limit` per the pagination trailer to read the rest.',
    effects: [],
    input_schema: {
      type: 'object',
      properties: {
        document_id: { type: 'string', description: 'Google Doc ID' },
        offset: { type: 'number', description: 'Character offset to start from (default 0).' },
        limit: { type: 'number', description: 'Characters to return (default 16000 ≈ 4K tokens). Don\'t exceed 20000.' },
      },
      required: ['document_id'],
    },
    concurrency: 'safe',
    maxResultTokens: 5000,
  },
  {
    name: 'sheets_read',
    description: 'Read data from a Google Sheets spreadsheet. Defaults to first ~16K chars (~4K tokens) of the rendered rows. For large sheets prefer narrowing via `range`; for very wide rendered output also use `offset` + `limit` per the pagination trailer.',
    effects: [],
    input_schema: {
      type: 'object',
      properties: {
        spreadsheet_id: { type: 'string', description: 'Spreadsheet ID' },
        range: { type: 'string', description: "Cell range to read (e.g., 'Sheet1!A1:D10', default: 'Sheet1'). Native pagination — narrow this first before falling back to offset/limit." },
        offset: { type: 'number', description: 'Character offset within the rendered rows (default 0). Useful for big rendered outputs.' },
        limit: { type: 'number', description: 'Characters to return (default 16000 ≈ 4K tokens).' },
      },
      required: ['spreadsheet_id'],
    },
    concurrency: 'safe',
    maxResultTokens: 5000,
  },
  {
    name: 'gmail_list_labels',
    description: 'List all of the user\'s Gmail labels (system + custom). Use this before calling gmail_label so you know which labels actually exist on this account. Returns each label\'s ID and name; system labels (INBOX, STARRED, SPAM, etc.) are flagged.',
    effects: [],
    input_schema: { type: 'object', properties: {}, required: [] },
    concurrency: 'safe',
    maxResultTokens: 1500,
  },
  {
    name: 'drive_versions_list',
    description: 'List the version history of a Google Drive file. Drive keeps automatic versions for ~30 days; pinned versions are kept indefinitely. Returns each version\'s ID, modified time, size, and whether it\'s pinned (keepForever).',
    effects: [],
    input_schema: {
      type: 'object',
      properties: {
        file_id: { type: 'string', description: 'Drive file ID.' },
      },
      required: ['file_id'],
    },
    concurrency: 'safe',
    maxResultTokens: 2000,
  },
  {
    name: 'calendar_freebusy',
    description: 'Check free/busy availability for one or more people across Google Calendars over a time window. Returns busy time blocks per attendee so you can pick a slot when everyone is free. Use this BEFORE proposing a meeting time - much cheaper than calendar_create + retry on conflicts.',
    effects: [],
    input_schema: {
      type: 'object',
      properties: {
        attendees: { type: 'array', items: { type: 'string' }, description: 'Email addresses to check (include the user themselves if you want their schedule too).' },
        start: { type: 'string', description: "Window start datetime (ISO 8601 WITH a UTC offset, e.g. '2026-05-30T08:00:00-07:00'; an offset-less time is assumed to be in the host timezone)." },
        end: { type: 'string', description: "Window end datetime (ISO 8601, same format as `start`)." },
      },
      required: ['attendees', 'start', 'end'],
    },
    concurrency: 'safe',
    maxResultTokens: 3000,
  },
];

// For each tool in USER_SLOT_READ_TOOLS, a `user_*` counterpart with the same executor and slot='user', so
// the agent picks the mailbox at tool-selection time. Always emitted, even with the user slot unconnected,
// because the exported array is consumed statically at startup; an unconnected call gets a clean
// "Not authenticated" naming the slot. Every read tool targets a per-slot-toggled service and threads the
// resolved `slot` into googleRead, so a variant is gated by isToolEnabledByService. The base list is
// snapshotted first so the appended variants are not iterated.
const googleReadBaseTools = [...googleReadToolDefinitions];
for (const baseDef of googleReadBaseTools) {
  const canonical = baseDef.name;
  googleReadToolDefinitions.push({
    ...baseDef,
    name: `user_${canonical}`,
    description: `[USER'S Google account variant of \`${canonical}\`] ${baseDef.description}\n\nThis variant reads from the user's connected Google account (configured in Settings → Channels → User's Google Accounts). The agent's own account is read by the unprefixed \`${canonical}\` tool. If the user has not connected a User account, this tool returns a friendly error pointing them at Settings.`,
  });
}

// Register concurrency + maxResultTokens with the partitioner / cap registry. A def without `concurrency`
// runs one call at a time; one without `maxResultTokens` gets no cap.
import { registerConcurrency, registerMaxResultTokens } from '../agent/v2/classifiers/concurrency.js';
import { compactCountNote } from '../agent/tool-helpers.js';
for (const def of googleReadToolDefinitions) {
  if (def.concurrency) registerConcurrency(def.name, def.concurrency);
  if (def.maxResultTokens) registerMaxResultTokens(def.name, def.maxResultTokens);
}

// Every Google read tool can target a connected account of its kind via an `account` param (its email).
// Omitted: the read resolver picks the lowest-position connected account and labels it when several exist.
for (const def of googleReadToolDefinitions) {
  const schema = def.input_schema as { properties?: Record<string, unknown> };
  if (schema.properties && !schema.properties.account) {
    schema.properties.account = {
      type: 'string',
      description: "Which connected account to act on, by its email address. Omit to use the only connected account of this type; required when more than one is connected.",
    };
  }
}

// `user_calendar_agenda` reads ONLY the owner's Google calendar. The base `calendar_agenda` is the merged
// cross-account view (dispatch routes it to the unified executor), so the user_* generator's inherited
// "merged" wording would mislead here. Restate the true, narrow scope.
{
  const userCalAgenda = googleReadToolDefinitions.find(t => t.name === 'user_calendar_agenda');
  if (userCalAgenda) {
    userCalAgenda.description =
      "[The OWNER'S Google calendar only] Show upcoming events on the owner's connected Google calendar. For the merged view across every connected calendar (agent + owner, Google + Microsoft) use calendar_agenda; for the owner's Microsoft calendar use user_calendar_agenda_ms.";
  }
}

// ── Tool Execution ──

// Shared per-account FETCH helpers. The narrow `calendar_agenda` / `gmail_search` cases below and the merged
// tools/unified-read.ts executors both call these, so provider-specific fetch + normalize logic lives in
// one place; they return STRUCTURED items and each renderer formats them. Import direction stays one-way
// (unified-read -> here, never back).

/** Normalized calendar event, provider-agnostic once times are parsed to Dates. */
export interface GoogleAgendaFetchItem {
  title: string;
  start: Date | null;
  end: Date | null;
  rawStart: string;
  rawEnd: string;
  allDay: boolean;
  location?: string;
  notes?: string;
}

/**
 * Read every page of a Google events list. Google returns one page plus
 * `nextPageToken` when more exist; keep asking until there is no token. Stops on
 * the first failed call (returning its error) and when a token repeats, so it can
 * never loop forever.
 */
export async function readAllEventPages<T>(
  readPage: (pageToken: string | undefined) => ReturnType<typeof googleRead>,
): Promise<{ ok: true; items: T[] } | { ok: false; error: string }> {
  const items: T[] = [];
  const seen = new Set<string>();
  let pageToken: string | undefined;
  for (;;) {
    const result = await readPage(pageToken);
    if (!result.ok) return { ok: false, error: result.error ?? 'unknown error' };
    const data = result.data as { items?: T[]; nextPageToken?: string } | undefined;
    if (data?.items) items.push(...data.items);
    const next = data?.nextPageToken;
    if (!next || seen.has(next)) return { ok: true, items };
    seen.add(next);
    pageToken = next;
  }
}

/** Fetch + normalize one account's events for a window. `accountId` is the row id (slot). */
export async function fetchAgendaItemsForAccount(
  accountId: string,
  window: { startISO: string; endISO: string; anchored: boolean },
  tz: string,
  agentId: string,
  agentName: string,
  opts?: { calendarId?: string; days?: number },
): Promise<{ ok: true; items: GoogleAgendaFetchItem[] } | { ok: false; error: string }> {
  const calendarId = opts?.calendarId ?? 'primary';
  const params = new URLSearchParams({
    timeMin: window.startISO,
    timeMax: window.endISO,
    singleEvents: 'true',
    orderBy: 'startTime',
    timeZone: tz,
  });
  type AgendaEvent = { summary?: string; start: { dateTime?: string; date?: string; timeZone?: string }; end: { dateTime?: string; date?: string; timeZone?: string }; location?: string; description?: string };
  const result = await readAllEventPages<AgendaEvent>((pageToken) => {
    const pageParams = new URLSearchParams(params);
    if (pageToken) pageParams.set('pageToken', pageToken);
    const url = `${CALENDAR_BASE}/calendars/${encodeURIComponent(calendarId)}/events?${pageParams.toString()}`;
    return googleRead(url, agentId, agentName, 'calendar_agenda', { days: opts?.days, timezone: tz, anchored: window.anchored, calendarId }, accountId);
  });
  if (!result.ok) return { ok: false, error: result.error };

  const items: GoogleAgendaFetchItem[] = result.items.map(e => {
    const isAllDay = !!(e.start.date && !e.start.dateTime);
    const rawStart = e.start.dateTime ?? e.start.date ?? '';
    const rawEnd = e.end.dateTime ?? e.end.date ?? '';
    return {
      title: eventTitle(e.summary),
      start: parseFlexibleTime(rawStart),
      end: parseFlexibleTime(rawEnd),
      rawStart,
      rawEnd,
      allDay: isAllDay,
      location: e.location,
      notes: e.description,
    };
  });
  return { ok: true, items };
}

// The narrow read cases append the ACTUAL other-surface data (otherCalendarsAgendaSection /
// otherMailboxesCountSection in tools/unified-read.ts), so a narrow result never reads as the whole picture.

export async function executeGoogleReadTool(
  name: string,
  args: Record<string, unknown>,
  agentId: string,
  agentName: string,
): Promise<string> {
  // The user_ prefix selects the KIND; the `account` param selects which of
  // that kind's connected accounts. `slot` carries the resolved account id,
  // threaded into googleRead/googleWrite.
  let kind: import('./auth.js').AccountSlot = 'agent';
  let canonicalName = name;
  if (name.startsWith('user_')) {
    kind = 'user';
    canonicalName = name.slice('user_'.length);
  }


  // READ resolver: a narrow read on a multi-account slot defaults to the primary connected account (the
  // ask-which-account error stays on the WRITE side). With >1 connected, `labelAccount` makes the result
  // name the account it read, and the "also checked" block surfaces the others.
  const { resolveGoogleAccountForRead } = await import('./accounts.js');
  const resolved = resolveGoogleAccountForRead(kind, args.account as string | undefined);
  if ('error' in resolved) return `Error: ${resolved.error}`;
  const slot = resolved.account.id;
  const acctLabel = resolved.labelAccount ? (resolved.account.email ?? slot) : null;

  switch (canonicalName) {
    case 'gmail_search':
      return executeGmailSearch(args, slot, acctLabel, agentId, agentName);

    case 'gmail_read': {
      const messageId = args.message_id as string;
      const url = `${GMAIL_BASE}/messages/${encodeURIComponent(messageId)}?format=full`;
      const result = await googleRead(url, agentId, agentName, 'gmail_read', { messageId }, slot);
      if (!result.ok) return `Error reading email: ${result.error}`;

      const data = result.data as {
        id: string;
        snippet: string;
        payload?: GmailMessagePart;
      };

      const headers = data?.payload?.headers ?? [];
      const from = headers.find(h => h.name === 'From')?.value ?? '';
      const to = headers.find(h => h.name === 'To')?.value ?? '';
      const subject = headers.find(h => h.name === 'Subject')?.value ?? '(no subject)';
      const date = headers.find(h => h.name === 'Date')?.value ?? '';
      const cc = headers.find(h => h.name === 'Cc')?.value ?? '';
      const replyToHeader = headers.find(h => h.name.toLowerCase() === 'reply-to')?.value ?? '';

      const body = extractGmailBodyText(data?.payload);

      // Surface attachment IDs so the agent can pass them to gmail_read_attachment.
      const attachments = downloadableAttachments(data?.payload);

      // Headers are always included in full; pagination only affects the body.
      const pagedBody = applyTextPagination(
        body || gmailSnippetText(data?.snippet) || '(empty body)',
        'gmail_read',
        { offset: args.offset as number | undefined, limit: args.limit as number | undefined },
        { message_id: messageId },
        12_000,
      );

      // The headers and the body are the sender's; the paging trailer and the attachment list's call are the platform's.
      let output = `${outsideSpan(`From: ${from}\nTo: ${to}${cc ? `\nCc: ${cc}` : ''}${replyToHeader ? `\nReply-To: ${replyToHeader}` : ''}\nSubject: ${subject}\nDate: ${fmtEmailDate(date)}`)}\n\n${pagedBody}`;
      if (attachments.length > 0) {
        const lines = attachments.map(a => {
          const name = a.filename || '(unnamed)';
          const size = a.body?.size ? ` ${Math.round(a.body.size / 1024)}KB` : '';
          return `- ${name} (${a.mimeType}${size})\n  attachment_id: ${a.body?.attachmentId}`;
        });
        output += `\n\nAttachments (${attachments.length}):\n${lines.map((item) => outsideSpan(item)).join('\n')}\n\nUse gmail_read_attachment(message_id, attachment_id) to download.`;   // a filename is the sender's
      }
      return output;
    }

    case 'gmail_list_attachments': {
      const messageId = args.message_id as string;
      const url = `${GMAIL_BASE}/messages/${encodeURIComponent(messageId)}?format=full`;
      const result = await googleRead(url, agentId, agentName, 'gmail_list_attachments', { messageId }, slot);
      if (!result.ok) return `Error fetching message: ${result.error}`;
      const data = result.data as { payload?: GmailMessagePart };
      const items = downloadableAttachments(data?.payload)
        .map(a => {
          const name = a.filename || '(unnamed)';
          const size = a.body?.size ? `${Math.round(a.body.size / 1024)}KB` : 'unknown size';
          return `- ${name} (${a.mimeType}, ${size})\n  attachment_id: ${a.body?.attachmentId}`;
        });
      if (items.length === 0) return 'No attachments on this email.';
      return `Attachments (${items.length}):\n\n${items.map((item) => outsideSpan(item)).join('\n\n')}\n\nUse gmail_read_attachment(message_id, attachment_id) to download to local disk.`;
    }

    case 'gmail_inbox': {
      const maxResults = (args.max_results as number) ?? 10;
      const unreadOnly = args.unread_only === true;
      const query = unreadOnly ? 'in:inbox is:unread' : 'in:inbox';

      const listUrl = `${GMAIL_BASE}/messages?q=${encodeURIComponent(query)}&maxResults=${maxResults}`;
      const result = await googleRead(listUrl, agentId, agentName, 'gmail_inbox', { maxResults, unreadOnly }, slot);
      if (!result.ok) return `Error fetching inbox: ${result.error}`;

      const data = result.data as { messages?: Array<{ id: string }> };
      if (!data?.messages || data.messages.length === 0) return unreadOnly ? 'No unread messages in inbox.' : 'Inbox is empty.';

      const details: string[] = [];
      const unfetched: string[] = [];
      for (const msg of data.messages.slice(0, maxResults)) {
        const detailUrl = `${GMAIL_BASE}/messages/${msg.id}?format=metadata&metadataHeaders=From&metadataHeaders=Subject&metadataHeaders=Date`;
        const detail = await googleRead(detailUrl, agentId, agentName, 'gmail_read', { messageId: msg.id }, slot);
        if (detail.ok) {
          const msgData = detail.data as { id: string; snippet: string; labelIds?: string[]; payload?: { headers?: Array<{ name: string; value: string }> } };
          const headers = msgData?.payload?.headers ?? [];
          const from = headers.find(h => h.name === 'From')?.value ?? '';
          const subject = headers.find(h => h.name === 'Subject')?.value ?? '(no subject)';
          const date = headers.find(h => h.name === 'Date')?.value ?? '';
          const unread = msgData?.labelIds?.includes('UNREAD') ? ' [UNREAD]' : '';
          details.push(`${unread}ID: ${msg.id} | From: ${from} | Subject: ${subject} | Date: ${fmtEmailDate(date)}`);
        } else {
          unfetched.push(msg.id);
        }
      }
      // Failed detail fetches must stay visible: name the ids so the worker can read them itself.
      const total = data.messages.length;
      if (details.length === 0) return `Inbox${acctLabel ? ` for ${acctLabel}` : ''} has ${total} message(s) but could not fetch details (ids ${unfetched.join(', ')}); try again.`;
      const note = unfetched.length > 0
        ? `\n\nNote: ${unfetched.length} of ${total} messages on this page could not be fetched and are not shown (ids ${unfetched.join(', ')}); read one with gmail_read(message_id=<id>) or check the inbox again.`
        : '';
      return `Inbox${acctLabel ? ` for ${acctLabel}` : ''} (${total} messages):\n\n${details.map((item) => outsideSpan(item)).join('\n')}${note}`;
    }

    case 'calendar_agenda': {
      // Base `calendar_agenda` is the merged cross-account view (tools/unified-read.ts); this case serves
      // user_calendar_agenda and internal single-account reuse.
      const days = (args.days as number) ?? 1;
      const tz = (args.timezone as string | undefined) ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
      const startDate = args.start_date as string | undefined;
      const calendarId = (args.calendar_id as string | undefined) ?? 'primary';
      const { computeCalendarWindow } = await import('../services/calendar-window.js');
      const window = computeCalendarWindow({ days, timezone: args.timezone as string | undefined, start_date: startDate });

      const fetched = await fetchAgendaItemsForAccount(slot, window, tz, agentId, agentName, { calendarId, days });
      if (!fetched.ok) return `Error fetching calendar: ${fetched.error}`;

      // The SAME window fetched from every OTHER connected calendar surface, compact and labeled, so a
      // single-calendar agenda never reads as the whole day.
      const { otherCalendarsAgendaSection } = await import('../tools/unified-read.js');
      const others = await otherCalendarsAgendaSection({ provider: 'google', accountId: slot }, window, tz, days, agentId, agentName);

      if (fetched.items.length === 0) return `No events in the next ${days} day(s)${acctLabel ? ` for ${acctLabel}` : ''}.` + others;

      // Google returns dateTime with an embedded offset (good) OR date for
      // all-day events. Either way, formatTimeRangeForAgent gives the
      // agent an unambiguous dual-format string so it doesn't misread the
      // ISO as its own local time.
      const { formatTimeRangeForAgent } = await import('../services/format-time.js');
      const events = fetched.items.map(e => {
        const when = e.start && e.end
          ? formatTimeRangeForAgent(e.start, e.end, { timezone: tz, allDay: e.allDay })
          : `${e.rawStart} to ${e.rawEnd} (could not parse)`;
        let line = `- ${e.title}\n  ${when}`;
        if (e.location) line += `\n  Location: ${e.location}`;
        if (e.notes) line += `\n  Notes: ${e.notes.slice(0, 200)}`;
        return line;
      });
      const agendaHeader = acctLabel
        ? `Calendar agenda for ${acctLabel} (next ${days} day(s)):`
        : `Calendar agenda (next ${days} day(s)):`;
      return `${agendaHeader}\n\n${events.map((item) => outsideSpan(item)).join('\n\n')}` + others;
    }

    case 'calendar_search': {
      const searchQuery = args.query as string;
      const daysAhead = (args.days_ahead as number) ?? 30;
      const calendarId = (args.calendar_id as string | undefined) ?? 'primary';
      const startDate = args.start_date as string | undefined;
      const { computeCalendarWindow } = await import('../services/calendar-window.js');
      const window = computeCalendarWindow({ days: daysAhead, timezone: args.timezone as string | undefined, start_date: startDate });

      const params = new URLSearchParams({
        timeMin: window.startISO,
        timeMax: window.endISO,
        singleEvents: 'true',
        orderBy: 'startTime',
        q: searchQuery,
      });
      const result = await readAllEventPages<{ summary?: string; start: { dateTime?: string; date?: string }; id: string }>((pageToken) => {
        const pageParams = new URLSearchParams(params);
        if (pageToken) pageParams.set('pageToken', pageToken);
        const url = `${CALENDAR_BASE}/calendars/${encodeURIComponent(calendarId)}/events?${pageParams.toString()}`;
        return googleRead(url, agentId, agentName, 'calendar_search', { query: searchQuery, daysAhead, startDate, anchored: window.anchored, calendarId }, slot);
      });
      if (!result.ok) return `Error searching calendar: ${result.error}`;

      const data = { items: result.items };
      if (data.items.length === 0) return `No events matching "${searchQuery}"${acctLabel ? ` in ${acctLabel}` : ''} in the next ${daysAhead} days.`;

      const requestedTz = args.timezone as string | undefined;
      const { parseFlexibleTime, formatTimeForAgent } = await import('../services/format-time.js');
      const events = data.items.map(e => {
        const isAllDay = !!(e.start.date && !e.start.dateTime);
        const raw = e.start.dateTime ?? e.start.date ?? '';
        const parsed = parseFlexibleTime(raw);
        const when = parsed
          ? formatTimeForAgent(parsed, { timezone: requestedTz, allDay: isAllDay })
          : `${raw} (could not parse)`;
        return `- ${eventTitle(e.summary)}\n  ${when}\n  [ID: ${e.id}]`;
      });
      return `Found ${data.items.length} event(s) matching "${searchQuery}"${acctLabel ? ` in ${acctLabel}` : ''}:\n\n${events.map((item) => outsideSpan(item)).join('\n')}`;
    }

    case 'calendar_list': {
      const url = `${CALENDAR_BASE}/users/me/calendarList`;
      const result = await googleRead(url, agentId, agentName, 'calendar_list', {}, slot);
      if (!result.ok) return `Error listing calendars: ${result.error}`;
      const data = result.data as { items?: Array<{ id: string; summary: string; summaryOverride?: string; accessRole: string; primary?: boolean; selected?: boolean; description?: string }> };
      if (!data?.items || data.items.length === 0) return 'No calendars accessible.';
      const lines = data.items.map(c => {
        const name = c.summaryOverride ?? c.summary ?? '(unnamed)';
        const tags = [c.primary ? 'primary' : null, c.accessRole].filter(Boolean).join(', ');
        const desc = c.description ? `\n  ${c.description.slice(0, 120)}` : '';
        return `- ${name} [${tags}]\n  ID: ${c.id}${desc}`;
      });
      return `${data.items.length} calendar(s)${acctLabel ? ` on ${acctLabel}` : ''}:\n\n${lines.map((item) => outsideSpan(item)).join('\n')}`;
    }

    case 'drive_list': {
      const driveQuery = args.query as string | undefined;
      const folderId = args.folder_id as string | undefined;
      const maxResults = (args.max_results as number) ?? 20;
      const verbose = args.verbose as boolean | undefined;

      // Drive's `and` binds tighter than `or`, so a search with an either-or in it is bracketed before any
      // `and` clause (the folder, then the Trash) joins it. Every test reads the search with its quoted values
      // emptied: a word inside a value (`or`, `trashed`) is not syntax.
      let q = '';
      if (driveQuery) {
        q = driveSearchQuery(driveQuery);
        if (/\bor\b/i.test(withoutQuotedValues(q))) q = `(${q})`;
      }
      if (folderId) {
        const folderQ = `'${folderId}' in parents`;
        q = q ? `${q} and ${folderQ}` : folderQ;
      }
      // Drive lists trashed files unless the query says otherwise. A query that already
      // mentions trashed is the model's own and passes through; every other one excludes the Trash.
      let trashLeftOut = false;
      if (!q) { q = 'trashed = false'; trashLeftOut = true; }
      else if (!/\btrashed\b/i.test(withoutQuotedValues(q))) { q = `${q} and trashed = false`; trashLeftOut = true; }

      const params = new URLSearchParams({
        q,
        pageSize: String(maxResults),
        fields: 'files(id, name, mimeType, modifiedTime, size)',
        supportsAllDrives: 'true',
        includeItemsFromAllDrives: 'true',
        corpora: 'allDrives',
      });
      const url = `${DRIVE_BASE}/files?${params.toString()}`;
      const result = await googleRead(url, agentId, agentName, 'drive_list', { query: driveQuery, folderId, maxResults }, slot);
      if (!result.ok) return `Error listing Drive files: ${result.error}`;

      const data = result.data as { files?: Array<{ id: string; name: string; mimeType: string; modifiedTime: string; size?: string }> };
      if (!data?.files || data.files.length === 0) return `No files found${acctLabel ? ` in ${acctLabel}` : ''}.${trashLeftOut ? ' Files in the Trash were left out; to search the Trash, add trashed = true to the query.' : ''}`;

      const files = data.files.map(f => {
        const size = f.size ? ` (${Math.round(parseInt(f.size) / 1024)}KB)` : '';
        if (verbose) {
          return `- ${f.name}${size}\n  ID: ${f.id}\n  Type: ${f.mimeType}\n  Modified: ${f.modifiedTime}`;
        }
        // Compact: one line per file (name, id, short type, modified date).
        // Drop the full mime type for known types; just say "doc" / "sheet" / etc.
        const shortType = f.mimeType.includes('document') ? 'doc'
          : f.mimeType.includes('spreadsheet') ? 'sheet'
          : f.mimeType.includes('presentation') ? 'slides'
          : f.mimeType.includes('folder') ? 'folder'
          : f.mimeType.includes('pdf') ? 'pdf'
          : f.mimeType.startsWith('image/') ? 'image'
          : 'file';
        return `- ${f.name}${size} [${shortType}] (${f.id}) — ${f.modifiedTime.slice(0, 10)}`;
      });

      const header = `Found ${data.files.length} file(s)${acctLabel ? ` in ${acctLabel}` : ''}:\n\n${files.map((item) => outsideSpan(item)).join(verbose ? '\n\n' : '\n')}`;
      if (verbose) return header;
      return `${header}\n\n${compactCountNote(files.length)}. For file content: drive_read(file_id=<id>). For full mime types + timestamps on every result: re-call drive_list with verbose=true.`;
    }

    case 'drive_read': {
      const fileId = args.file_id as string;

      // Get file metadata to determine type
      const metaUrl = `${DRIVE_BASE}/files/${encodeURIComponent(fileId)}?fields=id,name,mimeType&supportsAllDrives=true`;
      const meta = await googleRead(metaUrl, agentId, agentName, 'drive_read', { fileId }, slot);
      if (!meta.ok) return `Error reading file metadata: ${meta.error}`;

      const metaData = meta.data as { mimeType: string; name: string };
      const mimeType = metaData?.mimeType ?? '';

      // Google Docs: use Docs API (forwards offset/limit through)
      if (mimeType === 'application/vnd.google-apps.document') {
        return executeGoogleReadTool(kind === 'user' ? 'user_docs_read' : 'docs_read', { document_id: fileId, offset: args.offset, limit: args.limit, account: args.account }, agentId, agentName);
      }

      // Google Sheets: use Sheets API (range is sheet-native pagination; offset/limit also forwarded)
      if (mimeType === 'application/vnd.google-apps.spreadsheet') {
        return executeGoogleReadTool(kind === 'user' ? 'user_sheets_read' : 'sheets_read', { spreadsheet_id: fileId, offset: args.offset, limit: args.limit, account: args.account }, agentId, agentName);
      }

      // Other files: export as text and paginate.
      let body = '';
      const exportUrl = `${DRIVE_BASE}/files/${encodeURIComponent(fileId)}/export?mimeType=text/plain&supportsAllDrives=true`;
      const result = await googleRead(exportUrl, agentId, agentName, 'drive_read', { fileId, name: metaData?.name }, slot);
      if (!result.ok) {
        const downloadUrl = `${DRIVE_BASE}/files/${encodeURIComponent(fileId)}?alt=media&supportsAllDrives=true`;
        const dlResult = await googleRead(downloadUrl, agentId, agentName, 'drive_read', { fileId, name: metaData?.name }, slot);
        if (!dlResult.ok) return `Error reading file content: ${dlResult.error}`;
        body = typeof dlResult.data === 'string' ? dlResult.data : JSON.stringify(dlResult.data, null, 2);
      } else {
        body = typeof result.data === 'string' ? result.data : JSON.stringify(result.data, null, 2);
      }

      const paged = applyTextPagination(
        body,
        'drive_read',
        { offset: args.offset as number | undefined, limit: args.limit as number | undefined },
        { file_id: fileId },
        16_000,
      );
      return `File: ${outsideSpan(metaData?.name ?? fileId)}\n\n${paged}`;
    }

    case 'docs_read': {
      const docId = args.document_id as string;
      // Without includeTabsContent=true the API fills only the legacy `body` (the FIRST tab)
      // and leaves `tabs` empty.
      const url = `${DOCS_BASE}/${encodeURIComponent(docId)}?includeTabsContent=true`;
      const result = await googleRead(url, agentId, agentName, 'docs_read', { documentId: docId }, slot);
      if (!result.ok) return `Error reading Google Doc: ${result.error}`;

      const data = result.data as { title?: string; body?: { content?: DocBlock[] }; tabs?: DocTab[] };
      const title = data?.title ?? 'Untitled';

      const text = docTabsToText(data?.tabs) ?? docBlocksToText(data?.body?.content);
      const paged = applyTextPagination(
        text || '(empty document)',
        'docs_read',
        { offset: args.offset as number | undefined, limit: args.limit as number | undefined },
        { document_id: docId },
        16_000,
      );
      return `Document: ${outsideSpan(title)}\n\n${paged}`;
    }

    case 'sheets_read': {
      const spreadsheetId = args.spreadsheet_id as string;
      const range = (args.range as string) ?? await firstTabRange(spreadsheetId, agentId, agentName, slot);
      const url = `${SHEETS_BASE}/${encodeURIComponent(spreadsheetId)}/values/${encodeURIComponent(range)}`;
      const result = await googleRead(url, agentId, agentName, 'sheets_read', { spreadsheetId, range }, slot);
      if (!result.ok) return `Error reading spreadsheet: ${result.error}`;

      const data = result.data as { values?: string[][]; range?: string };
      if (!data?.values || data.values.length === 0) return `Spreadsheet range "${range}" is empty.`;

      const rows = data.values.map((row, i) => {
        const cells = row.map(cell => String(cell ?? '')).join(' | ');
        return `Row ${i + 1}: ${cells}`;
      });
      const fullText = rows.join('\n');
      const paged = applyTextPagination(
        fullText,
        'sheets_read',
        { offset: args.offset as number | undefined, limit: args.limit as number | undefined },
        { spreadsheet_id: spreadsheetId, range },
        16_000,
      );
      return `Spreadsheet data (${data.range ?? range}):\n\n${paged}`;
    }

    case 'drive_versions_list': {
      const fileId = encodeURIComponent(args.file_id as string);
      // Revisions come OLDEST first, one page per call. Follow the nextPageToken until
      // there is none; a server that keeps answering with a token it already gave stops
      // the loop and the result says the list may be incomplete (no page cap).
      const revisionsUrl = `${DRIVE_BASE}/files/${fileId}/revisions?fields=nextPageToken,revisions(id,modifiedTime,size,keepForever,lastModifyingUser/displayName)&pageSize=1000&supportsAllDrives=true`;
      const revs: Array<{ id: string; modifiedTime: string; size?: string; keepForever?: boolean; lastModifyingUser?: { displayName?: string } }> = [];
      const seenTokens = new Set<string>();
      let incomplete = false;
      let pageToken: string | undefined;
      for (;;) {
        const result = await googleRead(
          pageToken ? `${revisionsUrl}&pageToken=${encodeURIComponent(pageToken)}` : revisionsUrl,
          agentId, agentName, 'drive_versions_list', { fileId: args.file_id }, slot,
        );
        if (!result.ok) return `Error listing versions: ${result.error}`;
        const data = result.data as { nextPageToken?: string; revisions?: typeof revs };
        revs.push(...(data?.revisions ?? []));
        pageToken = data?.nextPageToken;
        if (!pageToken) break;
        if (seenTokens.has(pageToken)) { incomplete = true; break; }
        seenTokens.add(pageToken);
      }
      if (revs.length === 0) return 'No version history available (file may be too new or version tracking disabled for this file type).';
      const lines = revs.map(r => {
        const pin = r.keepForever ? ' [PINNED]' : '';
        const who = r.lastModifyingUser?.displayName ? ` by ${r.lastModifyingUser.displayName}` : '';
        const size = r.size ? ` | ${Math.round(parseInt(r.size, 10) / 1024)}KB` : '';
        return `- ${formatTimeForAgent(r.modifiedTime)}${who}${size}${pin}\n    ID: ${r.id}`;
      });
      return `${revs.length} version(s) (newest first):\n\n${lines.reverse().map((item) => outsideSpan(item)).join('\n')}${incomplete ? '\n\nThis list may be incomplete: not every page could be read.' : ''}`;
    }

    case 'calendar_freebusy': {
      const attendees = args.attendees as string[];
      const start = args.start as string;
      const end = args.end as string;
      // Google's freeBusy endpoint is a POST that takes a body. googleRead
      // only supports GET, so use googleWrite which threads body cleanly.
      const { googleWrite } = await import('./client.js');
      const body = {
        timeMin: toRfc3339WithOffset(start),
        timeMax: toRfc3339WithOffset(end),
        items: attendees.map(email => ({ id: email })),
      };
      const result = await googleWrite('POST', 'https://www.googleapis.com/calendar/v3/freeBusy', body, agentId, agentName, 'calendar_freebusy', { attendees, start, end }, undefined, slot);
      if (!result.ok) return `Error checking free/busy: ${result.error}`;
      const data = result.data as { calendars?: Record<string, { busy?: Array<{ start: string; end: string }>; errors?: Array<{ domain: string; reason: string }> }> };
      const calendars = data?.calendars ?? {};
      const lines: string[] = [`Free/busy for ${start} to ${end}:`];
      for (const email of attendees) {
        const cal = calendars[email];
        if (cal?.errors && cal.errors.length > 0) {
          lines.push(`\n${email}: ERROR - ${cal.errors.map(e => e.reason).join(', ')} (calendar may be private or email may be wrong)`);
          continue;
        }
        const busy = cal?.busy ?? [];
        if (busy.length === 0) {
          lines.push(`\n${email}: FREE the entire window.`);
        } else {
          lines.push(`\n${email}: ${busy.length} busy block(s):`);
          busy.forEach(b => lines.push(`  ${formatTimeForAgent(b.start)} → ${formatTimeForAgent(b.end)}`));
        }
      }
      return lines.join('\n');
    }

    case 'gmail_list_labels': {
      const result = await googleRead('https://gmail.googleapis.com/gmail/v1/users/me/labels', agentId, agentName, 'gmail_list_labels', {}, slot);
      if (!result.ok) return `Error listing labels: ${result.error}`;
      const data = result.data as { labels?: Array<{ id: string; name: string; type?: string }> };
      const labels = data?.labels ?? [];
      if (labels.length === 0) return 'No labels found.';
      const system = labels.filter(l => l.type === 'system');
      const custom = labels.filter(l => l.type !== 'system');
      const lines: string[] = [];
      if (custom.length > 0) {
        lines.push('Custom labels:');
        custom.forEach(l => lines.push(`- ${l.name}\n    ID: ${l.id}`));
      }
      if (system.length > 0) {
        if (lines.length > 0) lines.push('');
        lines.push('System labels:');
        system.forEach(l => lines.push(`- ${l.name} [system]\n    ID: ${l.id}`));
      }
      return `${labels.length} label(s) total (${custom.length} custom, ${system.length} system):\n\n${lines.join('\n')}\n\nPass the label NAME (not ID) to gmail_label add_labels / remove_labels - Gmail accepts either, but names are more readable.`;
    }

    default:
      return `Unknown Google read tool: ${name}`;
  }
}
