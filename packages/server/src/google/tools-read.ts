// ════════════════════════════════════════
// Google Workspace READ Tools — Native REST API
// Available to: primary, trainer, ronin, apprentice
// NOT available to: PM agent
// ════════════════════════════════════════

import type { ToolDefinition } from '../agent/tools.js';
import { googleRead } from './client.js';

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
];

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
  const { validateAgainstSchema } = await import('../agent/tool-helpers.js');
  const def = googleReadToolDefByName.get(name);
  const schemaErr = validateAgainstSchema(name, def?.input_schema as Parameters<typeof validateAgainstSchema>[1], args);
  if (schemaErr) return schemaErr;

  switch (name) {
    case 'gmail_search': {
      const query = args.query as string;
      const maxResults = (args.max_results as number) ?? 10;
      const verbose = args.verbose as boolean | undefined;

      const listUrl = `${GMAIL_BASE}/messages?q=${encodeURIComponent(query)}&maxResults=${maxResults}`;
      const result = await googleRead(listUrl, agentId, agentName, 'gmail_search', { query, maxResults });
      if (!result.ok) return `Error searching Gmail: ${result.error}`;

      const data = result.data as { messages?: Array<{ id: string; threadId: string }> };
      if (!data?.messages || data.messages.length === 0) return 'No emails found matching that query.';

      const details: string[] = [];
      for (const msg of data.messages.slice(0, maxResults)) {
        const detailUrl = `${GMAIL_BASE}/messages/${msg.id}?format=metadata&metadataHeaders=From&metadataHeaders=To&metadataHeaders=Subject&metadataHeaders=Date`;
        const detail = await googleRead(detailUrl, agentId, agentName, 'gmail_read', { messageId: msg.id });
        if (detail.ok) {
          const msgData = detail.data as { id: string; snippet: string; payload?: { headers?: Array<{ name: string; value: string }> } };
          const headers = msgData?.payload?.headers ?? [];
          const from = headers.find(h => h.name === 'From')?.value ?? '';
          const to = headers.find(h => h.name === 'To')?.value ?? '';
          const subject = headers.find(h => h.name === 'Subject')?.value ?? '(no subject)';
          const date = headers.find(h => h.name === 'Date')?.value ?? '';
          const snippet = msgData?.snippet ?? '';
          if (verbose) {
            details.push(`ID: ${msg.id}\nFrom: ${from}\nTo: ${to}\nSubject: ${subject}\nDate: ${date}\nSnippet: ${snippet}\n`);
          } else {
            // Compact: one line per email — drop To, keep snippet capped to 200ch.
            const shortSnippet = snippet.length > 200 ? snippet.slice(0, 200) + '…' : snippet;
            details.push(`- ${date} | ${from} — ${subject}\n  ID: ${msg.id} | ${shortSnippet}`);
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
      const result = await googleRead(url, agentId, agentName, 'gmail_read', { messageId });
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

      let output = `From: ${from}\nTo: ${to}${cc ? `\nCc: ${cc}` : ''}\nSubject: ${subject}\nDate: ${date}\n\n${pagedBody}`;
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
      const result = await googleRead(url, agentId, agentName, 'gmail_list_attachments', { messageId });
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
      const result = await googleRead(listUrl, agentId, agentName, 'gmail_inbox', { maxResults, unreadOnly });
      if (!result.ok) return `Error fetching inbox: ${result.error}`;

      const data = result.data as { messages?: Array<{ id: string }> };
      if (!data?.messages || data.messages.length === 0) return unreadOnly ? 'No unread messages in inbox.' : 'Inbox is empty.';

      const details: string[] = [];
      for (const msg of data.messages.slice(0, maxResults)) {
        const detailUrl = `${GMAIL_BASE}/messages/${msg.id}?format=metadata&metadataHeaders=From&metadataHeaders=Subject&metadataHeaders=Date`;
        const detail = await googleRead(detailUrl, agentId, agentName, 'gmail_read', { messageId: msg.id });
        if (detail.ok) {
          const msgData = detail.data as { id: string; snippet: string; labelIds?: string[]; payload?: { headers?: Array<{ name: string; value: string }> } };
          const headers = msgData?.payload?.headers ?? [];
          const from = headers.find(h => h.name === 'From')?.value ?? '';
          const subject = headers.find(h => h.name === 'Subject')?.value ?? '(no subject)';
          const date = headers.find(h => h.name === 'Date')?.value ?? '';
          const unread = msgData?.labelIds?.includes('UNREAD') ? ' [UNREAD]' : '';
          details.push(`${unread}ID: ${msg.id} | From: ${from} | Subject: ${subject} | Date: ${date}`);
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
      const result = await googleRead(url, agentId, agentName, 'calendar_agenda', { days, timezone: tz, startDate, anchored: window.anchored, calendarId });
      if (!result.ok) return `Error fetching calendar: ${result.error}`;

      const data = result.data as { items?: Array<{ summary: string; start: { dateTime?: string; date?: string }; end: { dateTime?: string; date?: string }; location?: string; description?: string }> };
      if (!data?.items || data.items.length === 0) return `No events in the next ${days} day(s).`;

      const events = data.items.map(e => {
        const start = e.start.dateTime ?? e.start.date ?? '';
        const eEnd = e.end.dateTime ?? e.end.date ?? '';
        let line = `- ${e.summary} (${start} to ${eEnd})`;
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
      const result = await googleRead(url, agentId, agentName, 'calendar_search', { query: searchQuery, daysAhead, startDate, anchored: window.anchored, calendarId });
      if (!result.ok) return `Error searching calendar: ${result.error}`;

      const data = result.data as { items?: Array<{ summary: string; start: { dateTime?: string; date?: string }; id: string }> };
      if (!data?.items || data.items.length === 0) return `No events matching "${searchQuery}" in the next ${daysAhead} days.`;

      const events = data.items.map(e => {
        const start = e.start.dateTime ?? e.start.date ?? '';
        return `- ${e.summary} (${start}) [ID: ${e.id}]`;
      });
      return `Found ${data.items.length} event(s) matching "${searchQuery}":\n\n${events.join('\n')}`;
    }

    case 'calendar_list': {
      const url = `${CALENDAR_BASE}/users/me/calendarList`;
      const result = await googleRead(url, agentId, agentName, 'calendar_list', {});
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
      const result = await googleRead(url, agentId, agentName, 'drive_list', { query: driveQuery, folderId, maxResults });
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
      const meta = await googleRead(metaUrl, agentId, agentName, 'drive_read', { fileId });
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
      const result = await googleRead(exportUrl, agentId, agentName, 'drive_read', { fileId, name: metaData?.name });
      if (!result.ok) {
        const downloadUrl = `${DRIVE_BASE}/files/${encodeURIComponent(fileId)}?alt=media`;
        const dlResult = await googleRead(downloadUrl, agentId, agentName, 'drive_read', { fileId, name: metaData?.name });
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
      const result = await googleRead(url, agentId, agentName, 'docs_read', { documentId: docId });
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
      const result = await googleRead(url, agentId, agentName, 'sheets_read', { spreadsheetId, range });
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

    default:
      return `Unknown Google read tool: ${name}`;
  }
}
