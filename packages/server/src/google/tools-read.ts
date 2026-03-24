// ════════════════════════════════════════
// Google Workspace READ Tools
// Available to: primary, trainer, ronin, apprentice
// NOT available to: PM agent
// ════════════════════════════════════════

import type { ToolDefinition } from '../agent/tools.js';
import { runGwsRead, escapeForJson } from './client.js';

// ── Tool Definitions ──

export const googleReadToolDefinitions: ToolDefinition[] = [
  {
    name: 'gmail_search',
    description: 'Search Gmail for emails matching a query. Uses Gmail search syntax (from:, to:, subject:, has:attachment, after:, before:, label:, etc.)',
    input_schema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: "Gmail search query (e.g., 'from:john@example.com after:2026/03/01')" },
        max_results: { type: 'number', description: 'Maximum number of results (default: 10)' },
      },
      required: ['query'],
    },
  },
  {
    name: 'gmail_read',
    description: 'Read a specific email by message ID. Returns sender, recipients, subject, date, body text, and attachment info.',
    input_schema: {
      type: 'object',
      properties: {
        message_id: { type: 'string', description: 'Gmail message ID (from gmail_search results)' },
      },
      required: ['message_id'],
    },
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
  },
  {
    name: 'calendar_agenda',
    description: "Show upcoming calendar events. Defaults to today's agenda.",
    input_schema: {
      type: 'object',
      properties: {
        days: { type: 'number', description: 'How many days ahead to show (1 = today only, 7 = this week, default: 1)' },
        timezone: { type: 'string', description: 'Timezone (defaults to system timezone)' },
      },
      required: [],
    },
  },
  {
    name: 'calendar_search',
    description: 'Search calendar events by text query.',
    input_schema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Search text to find in event titles and descriptions' },
        days_ahead: { type: 'number', description: 'How far ahead to search in days (default: 30)' },
      },
      required: ['query'],
    },
  },
  {
    name: 'drive_list',
    description: 'List files in Google Drive. Can filter by folder, file type, or search query.',
    input_schema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: "Drive search query (e.g., 'name contains report', 'mimeType = application/pdf')" },
        folder_id: { type: 'string', description: 'List files in a specific folder' },
        max_results: { type: 'number', description: 'Maximum results (default: 20)' },
      },
      required: [],
    },
  },
  {
    name: 'drive_read',
    description: 'Read the content of a Google Drive file (Docs, Sheets, or text files). Returns the text content.',
    input_schema: {
      type: 'object',
      properties: {
        file_id: { type: 'string', description: 'Google Drive file ID (from drive_list results)' },
      },
      required: ['file_id'],
    },
  },
  {
    name: 'docs_read',
    description: 'Read the full content of a Google Doc.',
    input_schema: {
      type: 'object',
      properties: {
        document_id: { type: 'string', description: 'Google Doc ID' },
      },
      required: ['document_id'],
    },
  },
  {
    name: 'sheets_read',
    description: 'Read data from a Google Sheets spreadsheet.',
    input_schema: {
      type: 'object',
      properties: {
        spreadsheet_id: { type: 'string', description: 'Spreadsheet ID' },
        range: { type: 'string', description: "Cell range to read (e.g., 'Sheet1!A1:D10', default: 'Sheet1')" },
      },
      required: ['spreadsheet_id'],
    },
  },
];

// ── Tool Execution ──

export function executeGoogleReadTool(
  name: string,
  args: Record<string, unknown>,
  agentId: string,
  agentName: string,
): string {
  switch (name) {
    case 'gmail_search': {
      const query = escapeForJson(args.query as string);
      const maxResults = (args.max_results as number) ?? 10;
      const result = runGwsRead(
        agentId, agentName, 'gmail_search',
        `gmail users messages list --params '{"q": "${query}", "maxResults": ${maxResults}}'`,
        { query: args.query, maxResults },
      );
      if (!result.ok) return `Error searching Gmail: ${result.error}`;

      const data = result.data as { messages?: Array<{ id: string; threadId: string }> };
      if (!data?.messages || data.messages.length === 0) return 'No emails found matching that query.';

      // Fetch details for each message (up to max)
      const details: string[] = [];
      for (const msg of data.messages.slice(0, maxResults)) {
        const detail = runGwsRead(
          agentId, agentName, 'gmail_read',
          `gmail users messages get --params '{"id": "${msg.id}", "format": "metadata", "metadataHeaders": ["From", "To", "Subject", "Date"]}'`,
          { messageId: msg.id },
        );
        if (detail.ok) {
          const msgData = detail.data as { id: string; snippet: string; payload?: { headers?: Array<{ name: string; value: string }> } };
          const headers = msgData?.payload?.headers ?? [];
          const from = headers.find(h => h.name === 'From')?.value ?? '';
          const to = headers.find(h => h.name === 'To')?.value ?? '';
          const subject = headers.find(h => h.name === 'Subject')?.value ?? '(no subject)';
          const date = headers.find(h => h.name === 'Date')?.value ?? '';
          details.push(`ID: ${msg.id}\nFrom: ${from}\nTo: ${to}\nSubject: ${subject}\nDate: ${date}\nSnippet: ${msgData?.snippet ?? ''}\n`);
        }
      }

      return details.length > 0
        ? `Found ${data.messages.length} email(s):\n\n${details.join('\n---\n')}`
        : `Found ${data.messages.length} email(s) but could not fetch details.`;
    }

    case 'gmail_read': {
      const messageId = escapeForJson(args.message_id as string);
      const result = runGwsRead(
        agentId, agentName, 'gmail_read',
        `gmail users messages get --params '{"id": "${messageId}", "format": "full"}'`,
        { messageId: args.message_id },
      );
      if (!result.ok) return `Error reading email: ${result.error}`;

      const data = result.data as {
        id: string;
        snippet: string;
        payload?: {
          headers?: Array<{ name: string; value: string }>;
          body?: { data?: string };
          parts?: Array<{ mimeType: string; body?: { data?: string } }>;
        };
      };

      const headers = data?.payload?.headers ?? [];
      const from = headers.find(h => h.name === 'From')?.value ?? '';
      const to = headers.find(h => h.name === 'To')?.value ?? '';
      const subject = headers.find(h => h.name === 'Subject')?.value ?? '(no subject)';
      const date = headers.find(h => h.name === 'Date')?.value ?? '';
      const cc = headers.find(h => h.name === 'Cc')?.value ?? '';

      // Extract body text
      let body = '';
      if (data?.payload?.body?.data) {
        body = Buffer.from(data.payload.body.data, 'base64url').toString('utf-8');
      } else if (data?.payload?.parts) {
        const textPart = data.payload.parts.find(p => p.mimeType === 'text/plain');
        if (textPart?.body?.data) {
          body = Buffer.from(textPart.body.data, 'base64url').toString('utf-8');
        }
      }

      // Check for attachments
      const attachments = data?.payload?.parts?.filter(p => p.mimeType !== 'text/plain' && p.mimeType !== 'text/html') ?? [];

      let output = `From: ${from}\nTo: ${to}${cc ? `\nCc: ${cc}` : ''}\nSubject: ${subject}\nDate: ${date}\n\n${body || data?.snippet || '(empty body)'}`;
      if (attachments.length > 0) {
        output += `\n\nAttachments: ${attachments.length} file(s)`;
      }

      return output;
    }

    case 'gmail_inbox': {
      const maxResults = (args.max_results as number) ?? 10;
      const unreadOnly = args.unread_only === true;
      const query = unreadOnly ? 'in:inbox is:unread' : 'in:inbox';
      const result = runGwsRead(
        agentId, agentName, 'gmail_inbox',
        `gmail users messages list --params '{"q": "${query}", "maxResults": ${maxResults}}'`,
        { maxResults, unreadOnly },
      );
      if (!result.ok) return `Error fetching inbox: ${result.error}`;

      const data = result.data as { messages?: Array<{ id: string }> };
      if (!data?.messages || data.messages.length === 0) return unreadOnly ? 'No unread messages in inbox.' : 'Inbox is empty.';

      const details: string[] = [];
      for (const msg of data.messages.slice(0, maxResults)) {
        const detail = runGwsRead(
          agentId, agentName, 'gmail_read',
          `gmail users messages get --params '{"id": "${msg.id}", "format": "metadata", "metadataHeaders": ["From", "Subject", "Date"]}'`,
          { messageId: msg.id },
        );
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
      const now = new Date();
      const end = new Date(now.getTime() + days * 86400000);
      const tz = (args.timezone as string) ?? Intl.DateTimeFormat().resolvedOptions().timeZone;

      const result = runGwsRead(
        agentId, agentName, 'calendar_agenda',
        `calendar events list --params '{"calendarId": "primary", "timeMin": "${now.toISOString()}", "timeMax": "${end.toISOString()}", "singleEvents": true, "orderBy": "startTime", "timeZone": "${escapeForJson(tz)}"}'`,
        { days, timezone: tz },
      );
      if (!result.ok) return `Error fetching calendar: ${result.error}`;

      const data = result.data as { items?: Array<{ summary: string; start: { dateTime?: string; date?: string }; end: { dateTime?: string; date?: string }; location?: string; description?: string }> };
      if (!data?.items || data.items.length === 0) return `No events in the next ${days} day(s).`;

      const events = data.items.map(e => {
        const start = e.start.dateTime ?? e.start.date ?? '';
        const end = e.end.dateTime ?? e.end.date ?? '';
        let line = `- ${e.summary} (${start} → ${end})`;
        if (e.location) line += `\n  Location: ${e.location}`;
        if (e.description) line += `\n  Notes: ${e.description.slice(0, 200)}`;
        return line;
      });

      return `Calendar agenda (next ${days} day(s)):\n\n${events.join('\n\n')}`;
    }

    case 'calendar_search': {
      const searchQuery = args.query as string;
      const daysAhead = (args.days_ahead as number) ?? 30;
      const now = new Date();
      const end = new Date(now.getTime() + daysAhead * 86400000);

      const result = runGwsRead(
        agentId, agentName, 'calendar_search',
        `calendar events list --params '{"calendarId": "primary", "timeMin": "${now.toISOString()}", "timeMax": "${end.toISOString()}", "singleEvents": true, "orderBy": "startTime", "q": "${escapeForJson(searchQuery)}"}'`,
        { query: searchQuery, daysAhead },
      );
      if (!result.ok) return `Error searching calendar: ${result.error}`;

      const data = result.data as { items?: Array<{ summary: string; start: { dateTime?: string; date?: string }; end: { dateTime?: string; date?: string }; id: string }> };
      if (!data?.items || data.items.length === 0) return `No events matching "${searchQuery}" in the next ${daysAhead} days.`;

      const events = data.items.map(e => {
        const start = e.start.dateTime ?? e.start.date ?? '';
        return `- ${e.summary} (${start}) [ID: ${e.id}]`;
      });

      return `Found ${data.items.length} event(s) matching "${searchQuery}":\n\n${events.join('\n')}`;
    }

    case 'drive_list': {
      const driveQuery = args.query as string | undefined;
      const folderId = args.folder_id as string | undefined;
      const maxResults = (args.max_results as number) ?? 20;

      let q = '';
      if (driveQuery) q = escapeForJson(driveQuery);
      if (folderId) {
        const folderQ = `'${escapeForJson(folderId)}' in parents`;
        q = q ? `${q} and ${folderQ}` : folderQ;
      }
      if (!q) q = "trashed = false";

      const result = runGwsRead(
        agentId, agentName, 'drive_list',
        `drive files list --params '{"q": "${q}", "pageSize": ${maxResults}, "fields": "files(id, name, mimeType, modifiedTime, size)"}'`,
        { query: driveQuery, folderId, maxResults },
      );
      if (!result.ok) return `Error listing Drive files: ${result.error}`;

      const data = result.data as { files?: Array<{ id: string; name: string; mimeType: string; modifiedTime: string; size?: string }> };
      if (!data?.files || data.files.length === 0) return 'No files found.';

      const files = data.files.map(f => {
        const size = f.size ? ` (${Math.round(parseInt(f.size) / 1024)}KB)` : '';
        return `- ${f.name}${size}\n  ID: ${f.id}\n  Type: ${f.mimeType}\n  Modified: ${f.modifiedTime}`;
      });

      return `Found ${data.files.length} file(s):\n\n${files.join('\n\n')}`;
    }

    case 'drive_read': {
      const fileId = escapeForJson(args.file_id as string);

      // First get file metadata to determine type
      const meta = runGwsRead(
        agentId, agentName, 'drive_read',
        `drive files get --params '{"fileId": "${fileId}", "fields": "id, name, mimeType"}'`,
        { fileId: args.file_id },
      );
      if (!meta.ok) return `Error reading file metadata: ${meta.error}`;

      const metaData = meta.data as { mimeType: string; name: string };
      const mimeType = metaData?.mimeType ?? '';

      // Google Docs — use Docs API
      if (mimeType === 'application/vnd.google-apps.document') {
        return executeGoogleReadTool('docs_read', { document_id: args.file_id }, agentId, agentName);
      }

      // Google Sheets — use Sheets API
      if (mimeType === 'application/vnd.google-apps.spreadsheet') {
        return executeGoogleReadTool('sheets_read', { spreadsheet_id: args.file_id, range: 'Sheet1' }, agentId, agentName);
      }

      // Other files — export as text
      const result = runGwsRead(
        agentId, agentName, 'drive_read',
        `drive files export --params '{"fileId": "${fileId}", "mimeType": "text/plain"}'`,
        { fileId: args.file_id, name: metaData?.name },
      );
      if (!result.ok) return `Error reading file content: ${result.error}`;

      const content = typeof result.data === 'string' ? result.data : JSON.stringify(result.data, null, 2);
      return `File: ${metaData?.name ?? fileId}\n\n${content.slice(0, 50000)}`;
    }

    case 'docs_read': {
      const docId = escapeForJson(args.document_id as string);
      const result = runGwsRead(
        agentId, agentName, 'docs_read',
        `docs documents get --params '{"documentId": "${docId}"}'`,
        { documentId: args.document_id },
      );
      if (!result.ok) return `Error reading Google Doc: ${result.error}`;

      // Extract text content from the structured document response
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

      return `Document: ${title}\n\n${text || '(empty document)'}`;
    }

    case 'sheets_read': {
      const spreadsheetId = escapeForJson(args.spreadsheet_id as string);
      const range = escapeForJson((args.range as string) ?? 'Sheet1');
      const result = runGwsRead(
        agentId, agentName, 'sheets_read',
        `sheets spreadsheets values get --params '{"spreadsheetId": "${spreadsheetId}", "range": "${range}"}'`,
        { spreadsheetId: args.spreadsheet_id, range },
      );
      if (!result.ok) return `Error reading spreadsheet: ${result.error}`;

      const data = result.data as { values?: string[][]; range?: string };
      if (!data?.values || data.values.length === 0) return `Spreadsheet range "${range}" is empty.`;

      // Format as a readable table
      const rows = data.values.map((row, i) => {
        const cells = row.map(cell => String(cell ?? '')).join(' | ');
        return `Row ${i + 1}: ${cells}`;
      });

      return `Spreadsheet data (${data.range ?? range}):\n\n${rows.join('\n')}`;
    }

    default:
      return `Unknown Google read tool: ${name}`;
  }
}
