// ════════════════════════════════════════
// Google Workspace READ Tools — Native REST API
// Available to: primary, trainer, ronin, apprentice
// NOT available to: PM agent
// ════════════════════════════════════════

import type { ToolDefinition } from '../agent/tools.js';
import { googleRead } from './client.js';
import { formatTimeForAgent, parseFlexibleTime } from '../services/format-time.js';

/**
 * Format an email Date header for agent consumption. RFC 2822 headers
 * like "Wed, 20 May 2026 19:00:00 +0000" have an offset, so parsing is
 * unambiguous — but the format differs from every other tool. Route
 * through formatTimeForAgent so the agent sees the same dual-format
 * string everywhere. Empty input passes through as empty.
 */
function fmtEmailDate(rfc2822: string): string {
  if (!rfc2822) return '';
  const parsed = parseFlexibleTime(rfc2822);
  return parsed ? formatTimeForAgent(parsed) : rfc2822;
}

const GMAIL_BASE = 'https://gmail.googleapis.com/gmail/v1/users/me';
const CALENDAR_BASE = 'https://www.googleapis.com/calendar/v3';
const DRIVE_BASE = 'https://www.googleapis.com/drive/v3';
const DOCS_BASE = 'https://docs.googleapis.com/v1/documents';
const SHEETS_BASE = 'https://sheets.googleapis.com/v4/spreadsheets';

// ── Tool Definitions (unchanged) ──

export const googleReadToolDefinitions: ToolDefinition[] = [
  {
    name: 'gmail_search',
    description: 'Search Gmail. Default returns one compact line per email (date | sender — subject + 200-char snippet + ID). For To/CC + full snippet on every result, pass verbose=true; for the full body of ONE email, use gmail_read(message_id).',
    input_schema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: "Gmail search query (e.g., 'from:john@example.com after:2026/03/01')" },
        max_results: { type: 'number', description: 'Maximum number of results (default: 10)' },
        verbose: { type: 'boolean', description: 'If true, include To/CC and the full snippet per result. Default false (one line per result).' },
      },
      required: ['query'],
    },
    concurrency: 'safe',
    maxResultTokens: 3000,
  },
  {
    name: 'gmail_read',
    description:
      'Read a specific email by message ID. Returns sender, recipients, subject, date, plain-text body, and attachment list (name + ID). The body is paginated: defaults to first ~12K chars (~3K tokens). For long emails, use `offset` + `limit`. To download an attachment, use gmail_read_attachment with the attachment ID.',
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
    description: "Show upcoming calendar events. Defaults to today's agenda on your primary calendar. Pass calendar_id to read from a shared calendar (use calendar_list to find IDs). When a user asks about a specific local day (e.g. \"events for Wednesday\"), pass start_date + timezone so the window aligns to local midnight rather than UTC — otherwise late-evening events that have already crossed into the next day in UTC will be missed.",
    input_schema: {
      type: 'object',
      properties: {
        days: { type: 'number', description: 'How many days to span (1 = a single day, 7 = a week, default 1).' },
        timezone: { type: 'string', description: 'IANA timezone (e.g. "America/Los_Angeles"). Defaults to the system timezone. When set, the window snaps to local midnight in this timezone.' },
        start_date: { type: 'string', description: 'Anchor the window to a specific local date in YYYY-MM-DD (interpreted in `timezone`). Use this when the user asks about a specific day like "Wednesday" or "tomorrow" — compute the date, then pass it here. Omit to default to "today" in the given timezone.' },
        calendar_id: { type: 'string', description: 'Calendar ID. Defaults to "primary" (your own). Use calendar_list to discover shared calendar IDs.' },
      },
      required: [],
    },
    concurrency: 'safe',
    maxResultTokens: 2000,
  },
  {
    name: 'calendar_search',
    description: 'Search calendar events by text query. Defaults to your primary calendar; pass calendar_id to search a shared one. Pass start_date + timezone when constraining to a specific local day.',
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
    description: 'List files in Google Drive. Default returns one compact line per file (name + size + short type + id + date). For full mime types and timestamps on every result, pass verbose=true; for the content of ONE file, use drive_read(file_id).',
    input_schema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: "Drive search query (e.g., 'name contains report', 'mimeType = application/pdf')" },
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
    input_schema: { type: 'object', properties: {}, required: [] },
    concurrency: 'safe',
    maxResultTokens: 1500,
  },
  {
    name: 'drive_versions_list',
    description: 'List the version history of a Google Drive file. Drive keeps automatic versions for ~30 days; pinned versions are kept indefinitely. Returns each version\'s ID, modified time, size, and whether it\'s pinned (keepForever).',
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
    input_schema: {
      type: 'object',
      properties: {
        attendees: { type: 'array', items: { type: 'string' }, description: 'Email addresses to check (include the user themselves if you want their schedule too).' },
        start: { type: 'string', description: "Window start datetime (ISO 8601, e.g., '2026-05-30T08:00:00')." },
        end: { type: 'string', description: 'Window end datetime (ISO 8601).' },
      },
      required: ['attendees', 'start', 'end'],
    },
    concurrency: 'safe',
    maxResultTokens: 3000,
  },
];

// ── v2.7.0 multi-account: user_* tool variants ──
//
// For each tool name in USER_SLOT_READ_TOOLS, generate a `user_*`
// counterpart that points at the same executor with slot='user'. The
// agent gets BOTH `gmail_inbox` (agent's mailbox) and `user_gmail_inbox`
// (user's mailbox) in their tool index so the choice is explicit at
// tool-selection time rather than parameter-fill time.
//
// Always emitted — even if the user slot isn't connected — because the
// exported array is consumed statically at startup. If the agent calls
// a user_* tool while the slot isn't connected, the client returns a
// clean "Not authenticated" message naming the slot.
// Full-parity (2026-06-17): every Google read tool gets a user-slot variant.
// All read tools target a per-slot-toggled service (gmail/calendar/drive/docs/
// sheets) and every read case threads the resolved `slot` into googleRead, so
// the variant is safe and gated by isToolEnabledByService (User slot connected
// AND service enabled). Snapshot the base list first so we don't iterate over
// the variants we're appending.
const googleReadBaseTools = [...googleReadToolDefinitions];
for (const baseDef of googleReadBaseTools) {
  const canonical = baseDef.name;
  googleReadToolDefinitions.push({
    ...baseDef,
    name: `user_${canonical}`,
    description: `[USER'S Google account variant of \`${canonical}\`] ${baseDef.description}\n\nThis variant reads from the user's connected Google account (configured in Settings → Google as the User slot). The agent's own account is read by the unprefixed \`${canonical}\` tool. If the user has not connected a User account, this tool returns a friendly error pointing them at Settings.`,
  });
}

// Phase 3.5 (2026-05-04) — register concurrency + maxResultTokens overrides
// with the v2 partitioner / cap registry. Defs without these fields fall
// through to the hardcoded TOOL_CATEGORY map (concurrency) or get no cap.
import { registerConcurrency, registerMaxResultTokens } from '../agent/v2/classifiers/concurrency.js';
for (const def of googleReadToolDefinitions) {
  if (def.concurrency) registerConcurrency(def.name, def.concurrency);
  if (def.maxResultTokens) registerMaxResultTokens(def.name, def.maxResultTokens);
}

// ── Tool Execution ──

const googleReadToolDefByName = new Map(googleReadToolDefinitions.map(t => [t.name, t]));

export async function executeGoogleReadTool(
  name: string,
  args: Record<string, unknown>,
  agentId: string,
  agentName: string,
): Promise<string> {
  // Strip user_ prefix → resolve account slot. Canonical name drives
  // validation + dispatch; `slot` is threaded into googleRead/googleWrite.
  let slot: import('./auth.js').AccountSlot = 'agent';
  let canonicalName = name;
  if (name.startsWith('user_')) {
    slot = 'user';
    canonicalName = name.slice('user_'.length);
  }

  const { validateAgainstSchema } = await import('../agent/tool-helpers.js');
  const def = googleReadToolDefByName.get(canonicalName);
  const schemaErr = validateAgainstSchema(canonicalName, def?.input_schema as Parameters<typeof validateAgainstSchema>[1], args);
  if (schemaErr) return schemaErr;

  switch (canonicalName) {
    case 'gmail_search': {
      const query = args.query as string;
      const maxResults = (args.max_results as number) ?? 10;
      const verbose = args.verbose as boolean | undefined;

      const listUrl = `${GMAIL_BASE}/messages?q=${encodeURIComponent(query)}&maxResults=${maxResults}`;
      const result = await googleRead(listUrl, agentId, agentName, 'gmail_search', { query, maxResults }, slot);
      if (!result.ok) return `Error searching Gmail: ${result.error}`;

      const data = result.data as { messages?: Array<{ id: string; threadId: string }> };
      if (!data?.messages || data.messages.length === 0) return 'No emails found matching that query.';

      const details: string[] = [];
      for (const msg of data.messages.slice(0, maxResults)) {
        const detailUrl = `${GMAIL_BASE}/messages/${msg.id}?format=metadata&metadataHeaders=From&metadataHeaders=To&metadataHeaders=Subject&metadataHeaders=Date`;
        const detail = await googleRead(detailUrl, agentId, agentName, 'gmail_read', { messageId: msg.id }, slot);
        if (detail.ok) {
          const msgData = detail.data as { id: string; snippet: string; payload?: { headers?: Array<{ name: string; value: string }> } };
          const headers = msgData?.payload?.headers ?? [];
          const from = headers.find(h => h.name === 'From')?.value ?? '';
          const to = headers.find(h => h.name === 'To')?.value ?? '';
          const subject = headers.find(h => h.name === 'Subject')?.value ?? '(no subject)';
          const date = headers.find(h => h.name === 'Date')?.value ?? '';
          const snippet = msgData?.snippet ?? '';
          const fmtDate = fmtEmailDate(date);
          if (verbose) {
            details.push(`ID: ${msg.id}\nFrom: ${from}\nTo: ${to}\nSubject: ${subject}\nDate: ${fmtDate}\nSnippet: ${snippet}\n`);
          } else {
            // Compact: one line per email — drop To, keep snippet capped to 200ch.
            const shortSnippet = snippet.length > 200 ? snippet.slice(0, 200) + '…' : snippet;
            details.push(`- ${fmtDate} | ${from} — ${subject}\n  ID: ${msg.id} | ${shortSnippet}`);
          }
        }
      }

      if (details.length === 0) return `Found ${data.messages.length} email(s) but could not fetch details.`;
      const header = `Found ${data.messages.length} email(s):\n\n${details.join(verbose ? '\n---\n' : '\n')}`;
      if (verbose) return header;
      return `${header}\n\n${details.length} compact result${details.length === 1 ? '' : 's'} shown. For full body of one: gmail_read(message_id=<id>). For To/CC + full snippet on every result: re-call gmail_search with verbose=true.`;
    }

    case 'gmail_read': {
      const messageId = args.message_id as string;
      const url = `${GMAIL_BASE}/messages/${encodeURIComponent(messageId)}?format=full`;
      const result = await googleRead(url, agentId, agentName, 'gmail_read', { messageId }, slot);
      if (!result.ok) return `Error reading email: ${result.error}`;

      const data = result.data as {
        id: string;
        snippet: string;
        payload?: {
          headers?: Array<{ name: string; value: string }>;
          body?: { data?: string };
          parts?: Array<{
            mimeType: string;
            filename?: string;
            body?: { data?: string; attachmentId?: string; size?: number };
          }>;
        };
      };

      const headers = data?.payload?.headers ?? [];
      const from = headers.find(h => h.name === 'From')?.value ?? '';
      const to = headers.find(h => h.name === 'To')?.value ?? '';
      const subject = headers.find(h => h.name === 'Subject')?.value ?? '(no subject)';
      const date = headers.find(h => h.name === 'Date')?.value ?? '';
      const cc = headers.find(h => h.name === 'Cc')?.value ?? '';

      let body = '';
      if (data?.payload?.body?.data) {
        body = Buffer.from(data.payload.body.data, 'base64url').toString('utf-8');
      } else if (data?.payload?.parts) {
        const textPart = data.payload.parts.find(p => p.mimeType === 'text/plain');
        if (textPart?.body?.data) {
          body = Buffer.from(textPart.body.data, 'base64url').toString('utf-8');
        }
      }

      // Phase 3.5 fix — surface attachment IDs so the agent can pass them to
      // gmail_read_attachment. Without this, gmail_read's "Attachments: 3 files"
      // text was a dead-end — no path back to actual files.
      const attachments = (data?.payload?.parts ?? []).filter(p =>
        p.mimeType !== 'text/plain' && p.mimeType !== 'text/html' && p.body?.attachmentId,
      );

      // Headers are always included in full; pagination only affects the body.
      const { applyTextPagination } = await import('../agent/tools.js');
      const pagedBody = applyTextPagination(
        body || data?.snippet || '(empty body)',
        'gmail_read',
        { offset: args.offset as number | undefined, limit: args.limit as number | undefined },
        { message_id: messageId },
        12_000,
      );

      let output = `From: ${from}\nTo: ${to}${cc ? `\nCc: ${cc}` : ''}\nSubject: ${subject}\nDate: ${fmtEmailDate(date)}\n\n${pagedBody}`;
      if (attachments.length > 0) {
        const lines = attachments.map(a => {
          const name = a.filename || '(unnamed)';
          const size = a.body?.size ? ` ${Math.round(a.body.size / 1024)}KB` : '';
          return `- ${name} (${a.mimeType}${size})\n  attachment_id: ${a.body?.attachmentId}`;
        });
        output += `\n\nAttachments (${attachments.length}):\n${lines.join('\n')}\n\nUse gmail_read_attachment(message_id, attachment_id) to download.`;
      }
      return output;
    }

    case 'gmail_list_attachments': {
      const messageId = args.message_id as string;
      const url = `${GMAIL_BASE}/messages/${encodeURIComponent(messageId)}?format=full`;
      const result = await googleRead(url, agentId, agentName, 'gmail_list_attachments', { messageId }, slot);
      if (!result.ok) return `Error fetching message: ${result.error}`;
      const data = result.data as {
        payload?: {
          parts?: Array<{
            mimeType: string;
            filename?: string;
            body?: { attachmentId?: string; size?: number };
          }>;
        };
      };
      const items = (data?.payload?.parts ?? [])
        .filter(p => p.body?.attachmentId)
        .map(a => {
          const name = a.filename || '(unnamed)';
          const size = a.body?.size ? `${Math.round(a.body.size / 1024)}KB` : 'unknown size';
          return `- ${name} (${a.mimeType}, ${size})\n  attachment_id: ${a.body?.attachmentId}`;
        });
      if (items.length === 0) return 'No attachments on this email.';
      return `Attachments (${items.length}):\n\n${items.join('\n\n')}\n\nUse gmail_read_attachment(message_id, attachment_id) to download to local disk.`;
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
        }
      }
      return `Inbox (${data.messages.length} messages):\n\n${details.join('\n')}`;
    }

    case 'calendar_agenda': {
      const days = (args.days as number) ?? 1;
      const tz = (args.timezone as string | undefined) ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
      const startDate = args.start_date as string | undefined;
      const calendarId = (args.calendar_id as string | undefined) ?? 'primary';
      const { computeCalendarWindow } = await import('../services/calendar-window.js');
      const window = computeCalendarWindow({ days, timezone: args.timezone as string | undefined, start_date: startDate });

      const params = new URLSearchParams({
        timeMin: window.startISO,
        timeMax: window.endISO,
        singleEvents: 'true',
        orderBy: 'startTime',
        timeZone: tz,
      });
      const url = `${CALENDAR_BASE}/calendars/${encodeURIComponent(calendarId)}/events?${params.toString()}`;
      const result = await googleRead(url, agentId, agentName, 'calendar_agenda', { days, timezone: tz, startDate, anchored: window.anchored, calendarId }, slot);
      if (!result.ok) return `Error fetching calendar: ${result.error}`;

      const data = result.data as { items?: Array<{ summary: string; start: { dateTime?: string; date?: string; timeZone?: string }; end: { dateTime?: string; date?: string; timeZone?: string }; location?: string; description?: string }> };
      if (!data?.items || data.items.length === 0) return `No events in the next ${days} day(s).`;

      // Google returns dateTime with an embedded offset (good) OR date for
      // all-day events. Either way, formatTimeRangeForAgent gives the
      // agent an unambiguous dual-format string so it doesn't misread the
      // ISO as its own local time.
      const { parseFlexibleTime, formatTimeRangeForAgent } = await import('../services/format-time.js');
      const events = data.items.map(e => {
        const isAllDay = !!(e.start.date && !e.start.dateTime);
        // dateTime already has an offset → parseFlexibleTime handles it.
        // date is a calendar date → parse as a plain Date (UTC midnight is fine
        // since formatTimeRangeForAgent renders all-day in UTC to preserve the date).
        const rawStart = e.start.dateTime ?? e.start.date ?? '';
        const rawEnd = e.end.dateTime ?? e.end.date ?? '';
        const startDate = parseFlexibleTime(rawStart);
        const endDate = parseFlexibleTime(rawEnd);
        const when = startDate && endDate
          ? formatTimeRangeForAgent(startDate, endDate, { timezone: tz, allDay: isAllDay })
          : `${rawStart} to ${rawEnd} (could not parse)`;
        let line = `- ${e.summary}\n  ${when}`;
        if (e.location) line += `\n  Location: ${e.location}`;
        if (e.description) line += `\n  Notes: ${e.description.slice(0, 200)}`;
        return line;
      });
      return `Calendar agenda (next ${days} day(s)):\n\n${events.join('\n\n')}`;
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
      const url = `${CALENDAR_BASE}/calendars/${encodeURIComponent(calendarId)}/events?${params.toString()}`;
      const result = await googleRead(url, agentId, agentName, 'calendar_search', { query: searchQuery, daysAhead, startDate, anchored: window.anchored, calendarId }, slot);
      if (!result.ok) return `Error searching calendar: ${result.error}`;

      const data = result.data as { items?: Array<{ summary: string; start: { dateTime?: string; date?: string }; id: string }> };
      if (!data?.items || data.items.length === 0) return `No events matching "${searchQuery}" in the next ${daysAhead} days.`;

      const requestedTz = args.timezone as string | undefined;
      const { parseFlexibleTime, formatTimeForAgent } = await import('../services/format-time.js');
      const events = data.items.map(e => {
        const isAllDay = !!(e.start.date && !e.start.dateTime);
        const raw = e.start.dateTime ?? e.start.date ?? '';
        const parsed = parseFlexibleTime(raw);
        const when = parsed
          ? formatTimeForAgent(parsed, { timezone: requestedTz, allDay: isAllDay })
          : `${raw} (could not parse)`;
        return `- ${e.summary}\n  ${when}\n  [ID: ${e.id}]`;
      });
      return `Found ${data.items.length} event(s) matching "${searchQuery}":\n\n${events.join('\n')}`;
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
      return `${data.items.length} calendar(s):\n\n${lines.join('\n')}`;
    }

    case 'drive_list': {
      const driveQuery = args.query as string | undefined;
      const folderId = args.folder_id as string | undefined;
      const maxResults = (args.max_results as number) ?? 20;
      const verbose = args.verbose as boolean | undefined;

      let q = '';
      if (driveQuery) q = driveQuery;
      if (folderId) {
        const folderQ = `'${folderId}' in parents`;
        q = q ? `${q} and ${folderQ}` : folderQ;
      }
      if (!q) q = 'trashed = false';

      const params = new URLSearchParams({
        q,
        pageSize: String(maxResults),
        fields: 'files(id, name, mimeType, modifiedTime, size)',
      });
      const url = `${DRIVE_BASE}/files?${params.toString()}`;
      const result = await googleRead(url, agentId, agentName, 'drive_list', { query: driveQuery, folderId, maxResults }, slot);
      if (!result.ok) return `Error listing Drive files: ${result.error}`;

      const data = result.data as { files?: Array<{ id: string; name: string; mimeType: string; modifiedTime: string; size?: string }> };
      if (!data?.files || data.files.length === 0) return 'No files found.';

      const files = data.files.map(f => {
        const size = f.size ? ` (${Math.round(parseInt(f.size) / 1024)}KB)` : '';
        if (verbose) {
          return `- ${f.name}${size}\n  ID: ${f.id}\n  Type: ${f.mimeType}\n  Modified: ${f.modifiedTime}`;
        }
        // Compact: one line per file — name + id + short type + modified date.
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

      const header = `Found ${data.files.length} file(s):\n\n${files.join(verbose ? '\n\n' : '\n')}`;
      if (verbose) return header;
      return `${header}\n\n${files.length} compact result${files.length === 1 ? '' : 's'} shown. For file content: drive_read(file_id=<id>). For full mime types + timestamps on every result: re-call drive_list with verbose=true.`;
    }

    case 'drive_read': {
      const fileId = args.file_id as string;

      // Get file metadata to determine type
      const metaUrl = `${DRIVE_BASE}/files/${encodeURIComponent(fileId)}?fields=id,name,mimeType`;
      const meta = await googleRead(metaUrl, agentId, agentName, 'drive_read', { fileId }, slot);
      if (!meta.ok) return `Error reading file metadata: ${meta.error}`;

      const metaData = meta.data as { mimeType: string; name: string };
      const mimeType = metaData?.mimeType ?? '';

      // Google Docs: use Docs API (forwards offset/limit through)
      if (mimeType === 'application/vnd.google-apps.document') {
        return executeGoogleReadTool('docs_read', { document_id: fileId, offset: args.offset, limit: args.limit }, agentId, agentName);
      }

      // Google Sheets: use Sheets API (range is sheet-native pagination; offset/limit also forwarded)
      if (mimeType === 'application/vnd.google-apps.spreadsheet') {
        return executeGoogleReadTool('sheets_read', { spreadsheet_id: fileId, range: 'Sheet1', offset: args.offset, limit: args.limit }, agentId, agentName);
      }

      // Other files: export as text and paginate.
      let body = '';
      const exportUrl = `${DRIVE_BASE}/files/${encodeURIComponent(fileId)}/export?mimeType=text/plain`;
      const result = await googleRead(exportUrl, agentId, agentName, 'drive_read', { fileId, name: metaData?.name }, slot);
      if (!result.ok) {
        const downloadUrl = `${DRIVE_BASE}/files/${encodeURIComponent(fileId)}?alt=media`;
        const dlResult = await googleRead(downloadUrl, agentId, agentName, 'drive_read', { fileId, name: metaData?.name }, slot);
        if (!dlResult.ok) return `Error reading file content: ${dlResult.error}`;
        body = typeof dlResult.data === 'string' ? dlResult.data : JSON.stringify(dlResult.data, null, 2);
      } else {
        body = typeof result.data === 'string' ? result.data : JSON.stringify(result.data, null, 2);
      }

      const { applyTextPagination } = await import('../agent/tools.js');
      const paged = applyTextPagination(
        body,
        'drive_read',
        { offset: args.offset as number | undefined, limit: args.limit as number | undefined },
        { file_id: fileId },
        16_000,
      );
      return `File: ${metaData?.name ?? fileId}\n\n${paged}`;
    }

    case 'docs_read': {
      const docId = args.document_id as string;
      const url = `${DOCS_BASE}/${encodeURIComponent(docId)}`;
      const result = await googleRead(url, agentId, agentName, 'docs_read', { documentId: docId }, slot);
      if (!result.ok) return `Error reading Google Doc: ${result.error}`;

      const data = result.data as { title?: string; body?: { content?: Array<{ paragraph?: { elements?: Array<{ textRun?: { content: string } }> } }> } };
      const title = data?.title ?? 'Untitled';

      let text = '';
      if (data?.body?.content) {
        for (const block of data.body.content) {
          if (block?.paragraph?.elements) {
            for (const element of block.paragraph.elements) {
              if (element?.textRun?.content) {
                text += element.textRun.content;
              }
            }
          }
        }
      }
      const { applyTextPagination } = await import('../agent/tools.js');
      const paged = applyTextPagination(
        text || '(empty document)',
        'docs_read',
        { offset: args.offset as number | undefined, limit: args.limit as number | undefined },
        { document_id: docId },
        16_000,
      );
      return `Document: ${title}\n\n${paged}`;
    }

    case 'sheets_read': {
      const spreadsheetId = args.spreadsheet_id as string;
      const range = (args.range as string) ?? 'Sheet1';
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
      const { applyTextPagination } = await import('../agent/tools.js');
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
      const result = await googleRead(
        `https://www.googleapis.com/drive/v3/files/${fileId}/revisions?fields=revisions(id,modifiedTime,size,keepForever,lastModifyingUser/displayName)`,
        agentId, agentName, 'drive_versions_list', { fileId: args.file_id }, slot,
      );
      if (!result.ok) return `Error listing versions: ${result.error}`;
      const data = result.data as { revisions?: Array<{ id: string; modifiedTime: string; size?: string; keepForever?: boolean; lastModifyingUser?: { displayName?: string } }> };
      const revs = data?.revisions ?? [];
      if (revs.length === 0) return 'No version history available (file may be too new or version tracking disabled for this file type).';
      const lines = revs.map(r => {
        const pin = r.keepForever ? ' [PINNED]' : '';
        const who = r.lastModifyingUser?.displayName ? ` by ${r.lastModifyingUser.displayName}` : '';
        const size = r.size ? ` | ${Math.round(parseInt(r.size, 10) / 1024)}KB` : '';
        return `- ${formatTimeForAgent(r.modifiedTime)}${who}${size}${pin}\n    ID: ${r.id}`;
      });
      return `${revs.length} version(s) (newest first):\n\n${lines.reverse().join('\n')}`;
    }

    case 'calendar_freebusy': {
      const attendees = args.attendees as string[];
      const start = args.start as string;
      const end = args.end as string;
      // Google's freeBusy endpoint is a POST that takes a body. googleRead
      // only supports GET, so use googleWrite which threads body cleanly.
      const { googleWrite } = await import('./client.js');
      const body = {
        timeMin: start,
        timeMax: end,
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
