// ════════════════════════════════════════
// Google Workspace WRITE Tools — Native REST API
// Available to: primary agent ONLY
// ════════════════════════════════════════

import type { ToolDefinition } from '../agent/tools.js';
import { googleRead, googleWrite } from './client.js';

const GMAIL_BASE = 'https://gmail.googleapis.com/gmail/v1/users/me';
const CALENDAR_BASE = 'https://www.googleapis.com/calendar/v3';
const DRIVE_BASE = 'https://www.googleapis.com/drive/v3';
const DOCS_BASE = 'https://docs.googleapis.com/v1/documents';
const SHEETS_BASE = 'https://sheets.googleapis.com/v4/spreadsheets';
const UPLOAD_BASE = 'https://www.googleapis.com/upload/drive/v3';

// ── Tool Definitions (unchanged) ──

export const googleWriteToolDefinitions: ToolDefinition[] = [
  {
    name: 'gmail_send',
    description: 'Send an email from the connected Google account.',
    input_schema: {
      type: 'object',
      properties: {
        to: { type: 'string', description: 'Recipient email address (or comma-separated list)' },
        subject: { type: 'string', description: 'Email subject line' },
        body: { type: 'string', description: 'Email body text' },
        cc: { type: 'string', description: 'CC recipients (comma-separated)' },
        bcc: { type: 'string', description: 'BCC recipients (comma-separated)' },
      },
      required: ['to', 'subject', 'body'],
    },
  },
  {
    name: 'gmail_reply',
    description: 'Reply to an existing email thread.',
    input_schema: {
      type: 'object',
      properties: {
        message_id: { type: 'string', description: 'Message ID to reply to' },
        body: { type: 'string', description: 'Reply body text' },
        reply_all: { type: 'boolean', description: 'Reply to all recipients (default: false)' },
      },
      required: ['message_id', 'body'],
    },
  },
  {
    name: 'gmail_forward',
    description: 'Forward an email to new recipients.',
    input_schema: {
      type: 'object',
      properties: {
        message_id: { type: 'string', description: 'Message ID to forward' },
        to: { type: 'string', description: 'Forward to this email address' },
        body: { type: 'string', description: 'Additional text to include' },
      },
      required: ['message_id', 'to'],
    },
  },
  {
    name: 'gmail_label',
    description: 'Add or remove labels from an email (move to folders, archive, etc.)',
    input_schema: {
      type: 'object',
      properties: {
        message_id: { type: 'string', description: 'Message ID' },
        add_labels: { type: 'array', items: { type: 'string' }, description: "Labels to add (e.g., 'IMPORTANT', 'STARRED')" },
        remove_labels: { type: 'array', items: { type: 'string' }, description: "Labels to remove (e.g., 'INBOX' to archive)" },
      },
      required: ['message_id'],
    },
  },
  {
    name: 'calendar_create',
    description: 'Create a new calendar event.',
    input_schema: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'Event title' },
        start: { type: 'string', description: "Start datetime (ISO 8601, e.g., '2026-03-25T10:00:00')" },
        end: { type: 'string', description: 'End datetime (ISO 8601)' },
        description: { type: 'string', description: 'Event description' },
        attendees: { type: 'array', items: { type: 'string' }, description: 'Attendee email addresses' },
        location: { type: 'string', description: 'Event location' },
      },
      required: ['title', 'start', 'end'],
    },
  },
  {
    name: 'calendar_update',
    description: 'Update an existing calendar event.',
    input_schema: {
      type: 'object',
      properties: {
        event_id: { type: 'string', description: 'Calendar event ID' },
        title: { type: 'string', description: 'New event title' },
        start: { type: 'string', description: 'New start datetime' },
        end: { type: 'string', description: 'New end datetime' },
        description: { type: 'string', description: 'New event description' },
      },
      required: ['event_id'],
    },
  },
  {
    name: 'calendar_delete',
    description: 'Delete a calendar event.',
    input_schema: {
      type: 'object',
      properties: {
        event_id: { type: 'string', description: 'Calendar event ID to delete' },
      },
      required: ['event_id'],
    },
  },
  {
    name: 'drive_upload',
    description: 'Upload a file from the local machine to Google Drive.',
    input_schema: {
      type: 'object',
      properties: {
        file_path: { type: 'string', description: 'Local file path to upload' },
        name: { type: 'string', description: 'Name for the file in Drive (defaults to local filename)' },
        folder_id: { type: 'string', description: 'Upload to a specific Drive folder' },
      },
      required: ['file_path'],
    },
  },
  {
    name: 'drive_share',
    description: 'Share a Google Drive file or folder with someone.',
    input_schema: {
      type: 'object',
      properties: {
        file_id: { type: 'string', description: 'File or folder ID to share' },
        email: { type: 'string', description: 'Email address to share with' },
        role: { type: 'string', description: "Permission level: 'reader', 'writer', or 'commenter' (default: 'reader')" },
      },
      required: ['file_id', 'email'],
    },
  },
  {
    name: 'docs_create',
    description: 'Create a new Google Doc with optional initial content.',
    input_schema: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'Document title' },
        content: { type: 'string', description: 'Initial text content for the document' },
      },
      required: ['title'],
    },
  },
  {
    name: 'docs_edit',
    description: 'Append text to an existing Google Doc.',
    input_schema: {
      type: 'object',
      properties: {
        document_id: { type: 'string', description: 'Google Doc ID' },
        content: { type: 'string', description: 'Text to append to the document' },
      },
      required: ['document_id', 'content'],
    },
  },
  {
    name: 'sheets_create',
    description: 'Create a new Google Sheets spreadsheet.',
    input_schema: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'Spreadsheet title' },
        headers: { type: 'array', items: { type: 'string' }, description: 'Column headers for the first row' },
      },
      required: ['title'],
    },
  },
  {
    name: 'sheets_append',
    description: 'Append a row of data to a Google Sheets spreadsheet.',
    input_schema: {
      type: 'object',
      properties: {
        spreadsheet_id: { type: 'string', description: 'Spreadsheet ID' },
        values: { type: 'string', description: 'Comma-separated values to append as a new row' },
        range: { type: 'string', description: "Sheet name or range (default: 'Sheet1')" },
      },
      required: ['spreadsheet_id', 'values'],
    },
  },
  {
    name: 'sheets_write',
    description: 'Write data to specific cells in a Google Sheets spreadsheet.',
    input_schema: {
      type: 'object',
      properties: {
        spreadsheet_id: { type: 'string', description: 'Spreadsheet ID' },
        range: { type: 'string', description: "Cell range (e.g., 'Sheet1!A1:C3')" },
        values: { type: 'array', items: { type: 'array', items: { type: 'string' } }, description: '2D array of cell values' },
      },
      required: ['spreadsheet_id', 'range', 'values'],
    },
  },
  // NOTE: slides_create has been migrated to tools-slides.ts as slides_create_presentation.
  // See packages/server/src/google/tools-slides.ts for the full slides toolkit.
];

// ── Helpers ──

function buildRfc2822Email(to: string, subject: string, body: string, options?: { cc?: string; bcc?: string; inReplyTo?: string; references?: string; threadId?: string }): string {
  const lines: string[] = [];
  lines.push(`To: ${to}`);
  lines.push(`Subject: ${subject}`);
  if (options?.cc) lines.push(`Cc: ${options.cc}`);
  if (options?.bcc) lines.push(`Bcc: ${options.bcc}`);
  if (options?.inReplyTo) lines.push(`In-Reply-To: ${options.inReplyTo}`);
  if (options?.references) lines.push(`References: ${options.references}`);
  lines.push('Content-Type: text/plain; charset=utf-8');
  lines.push('');
  lines.push(body);

  return Buffer.from(lines.join('\r\n')).toString('base64url');
}

// ── Tool Execution ──

export async function executeGoogleWriteTool(
  name: string,
  args: Record<string, unknown>,
  agentId: string,
  agentName: string,
): Promise<string> {
  switch (name) {
    case 'gmail_send': {
      const to = args.to as string;
      const subject = args.subject as string;
      const body = args.body as string;

      const raw = buildRfc2822Email(to, subject, body, {
        cc: args.cc as string | undefined,
        bcc: args.bcc as string | undefined,
      });

      const result = await googleWrite('POST', `${GMAIL_BASE}/messages/send`, { raw }, agentId, agentName, 'gmail_send', { to, subject });
      if (!result.ok) return `Error sending email: ${result.error}`;
      return `Email sent to ${to} with subject "${subject}"`;
    }

    case 'gmail_reply': {
      const messageId = args.message_id as string;
      const body = args.body as string;

      // Fetch original message to get thread ID and headers
      const origUrl = `${GMAIL_BASE}/messages/${encodeURIComponent(messageId)}?format=metadata&metadataHeaders=From&metadataHeaders=To&metadataHeaders=Subject&metadataHeaders=Message-ID`;
      const orig = await googleRead(origUrl, agentId, agentName, 'gmail_reply_fetch', { messageId });
      if (!orig.ok) return `Error fetching original message: ${orig.error}`;

      const origData = orig.data as { threadId: string; payload?: { headers?: Array<{ name: string; value: string }> } };
      const headers = origData?.payload?.headers ?? [];
      const from = headers.find(h => h.name === 'From')?.value ?? '';
      const to = headers.find(h => h.name === 'To')?.value ?? '';
      const subject = headers.find(h => h.name === 'Subject')?.value ?? '';
      const msgIdHeader = headers.find(h => h.name === 'Message-ID')?.value ?? '';
      const replyAll = args.reply_all === true;
      const replyTo = replyAll ? [from, to].filter(Boolean).join(', ') : from;
      const replySubject = subject.startsWith('Re:') ? subject : `Re: ${subject}`;

      const raw = buildRfc2822Email(replyTo, replySubject, body, {
        inReplyTo: msgIdHeader,
        references: msgIdHeader,
      });

      const result = await googleWrite('POST', `${GMAIL_BASE}/messages/send`, { raw, threadId: origData.threadId }, agentId, agentName, 'gmail_reply', { messageId, replyAll });
      if (!result.ok) return `Error replying to email: ${result.error}`;
      return `Reply sent${replyAll ? ' (to all)' : ''} to message ${messageId}`;
    }

    case 'gmail_forward': {
      const messageId = args.message_id as string;
      const to = args.to as string;
      const additionalBody = (args.body as string) ?? '';

      // Fetch original message
      const origUrl = `${GMAIL_BASE}/messages/${encodeURIComponent(messageId)}?format=full`;
      const orig = await googleRead(origUrl, agentId, agentName, 'gmail_forward_fetch', { messageId });
      if (!orig.ok) return `Error fetching original message: ${orig.error}`;

      const origData = orig.data as { payload?: { headers?: Array<{ name: string; value: string }>; body?: { data?: string }; parts?: Array<{ mimeType: string; body?: { data?: string } }> } };
      const headers = origData?.payload?.headers ?? [];
      const origSubject = headers.find(h => h.name === 'Subject')?.value ?? '';
      const origFrom = headers.find(h => h.name === 'From')?.value ?? '';

      let origBody = '';
      if (origData?.payload?.body?.data) {
        origBody = Buffer.from(origData.payload.body.data, 'base64url').toString('utf-8');
      } else if (origData?.payload?.parts) {
        const textPart = origData.payload.parts.find(p => p.mimeType === 'text/plain');
        if (textPart?.body?.data) {
          origBody = Buffer.from(textPart.body.data, 'base64url').toString('utf-8');
        }
      }

      const fwdBody = `${additionalBody}\n\n---------- Forwarded message ----------\nFrom: ${origFrom}\nSubject: ${origSubject}\n\n${origBody}`;
      const fwdSubject = origSubject.startsWith('Fwd:') ? origSubject : `Fwd: ${origSubject}`;

      const raw = buildRfc2822Email(to, fwdSubject, fwdBody);
      const result = await googleWrite('POST', `${GMAIL_BASE}/messages/send`, { raw }, agentId, agentName, 'gmail_forward', { messageId, to });
      if (!result.ok) return `Error forwarding email: ${result.error}`;
      return `Email forwarded to ${to}`;
    }

    case 'gmail_label': {
      const messageId = args.message_id as string;
      const addLabels = (args.add_labels as string[]) ?? [];
      const removeLabels = (args.remove_labels as string[]) ?? [];

      const url = `${GMAIL_BASE}/messages/${encodeURIComponent(messageId)}/modify`;
      const result = await googleWrite('POST', url, { addLabelIds: addLabels, removeLabelIds: removeLabels }, agentId, agentName, 'gmail_label', { messageId, addLabels, removeLabels });
      if (!result.ok) return `Error modifying labels: ${result.error}`;
      return `Labels updated on message ${messageId}`;
    }

    case 'calendar_create': {
      const event: Record<string, unknown> = {
        summary: args.title,
        start: { dateTime: args.start },
        end: { dateTime: args.end },
      };
      if (args.description) event.description = args.description;
      if (args.location) event.location = args.location;
      if (args.attendees) {
        event.attendees = (args.attendees as string[]).map(email => ({ email }));
      }

      const url = `${CALENDAR_BASE}/calendars/primary/events`;
      const result = await googleWrite('POST', url, event, agentId, agentName, 'calendar_create', { title: args.title, start: args.start, end: args.end });
      if (!result.ok) return `Error creating event: ${result.error}`;

      const data = result.data as { id?: string; htmlLink?: string };
      return `Calendar event "${args.title}" created${data?.id ? ` (ID: ${data.id})` : ''}${data?.htmlLink ? `\nLink: ${data.htmlLink}` : ''}`;
    }

    case 'calendar_update': {
      const eventId = args.event_id as string;
      const patch: Record<string, unknown> = {};
      if (args.title) patch.summary = args.title;
      if (args.start) patch.start = { dateTime: args.start };
      if (args.end) patch.end = { dateTime: args.end };
      if (args.description) patch.description = args.description;

      const url = `${CALENDAR_BASE}/calendars/primary/events/${encodeURIComponent(eventId)}`;
      const result = await googleWrite('PATCH', url, patch, agentId, agentName, 'calendar_update', { eventId, ...patch });
      if (!result.ok) return `Error updating event: ${result.error}`;
      return `Calendar event ${eventId} updated`;
    }

    case 'calendar_delete': {
      const eventId = args.event_id as string;
      const url = `${CALENDAR_BASE}/calendars/primary/events/${encodeURIComponent(eventId)}`;
      const result = await googleWrite('DELETE', url, undefined, agentId, agentName, 'calendar_delete', { eventId });
      if (!result.ok) return `Error deleting event: ${result.error}`;
      return `Calendar event ${eventId} deleted`;
    }

    case 'drive_upload': {
      const filePath = args.file_path as string;
      const fileName = (args.name as string) ?? filePath.split('/').pop() ?? 'upload';
      const folderId = args.folder_id as string | undefined;

      // Read file
      const fs = await import('node:fs');
      if (!fs.existsSync(filePath)) return `Error: File not found: ${filePath}`;
      const fileContent = fs.readFileSync(filePath);

      // Create file metadata
      const metadata: Record<string, unknown> = { name: fileName };
      if (folderId) metadata.parents = [folderId];

      // Use multipart upload
      const boundary = '---dojo-upload-boundary---';
      const metadataPart = JSON.stringify(metadata);
      const multipartBody = [
        `--${boundary}`,
        'Content-Type: application/json; charset=UTF-8',
        '',
        metadataPart,
        `--${boundary}`,
        'Content-Type: application/octet-stream',
        '',
      ].join('\r\n');

      const bodyBuffer = Buffer.concat([
        Buffer.from(multipartBody + '\r\n'),
        fileContent,
        Buffer.from(`\r\n--${boundary}--`),
      ]);

      const result = await googleWrite(
        'POST',
        `${UPLOAD_BASE}/files?uploadType=multipart`,
        bodyBuffer.toString('base64'),
        agentId, agentName, 'drive_upload',
        { filePath, name: fileName, folderId },
        `multipart/related; boundary=${boundary}`,
      );

      // Fallback: use simple metadata-only upload if multipart fails
      if (!result.ok) {
        // Simple approach: create empty file then would need to upload content separately
        return `Error uploading file: ${result.error}`;
      }

      const data = result.data as { id?: string; name?: string };
      return `File uploaded to Drive${data?.name ? `: ${data.name}` : ''}${data?.id ? ` (ID: ${data.id})` : ''}`;
    }

    case 'drive_share': {
      const fileId = args.file_id as string;
      const email = args.email as string;
      const role = (args.role as string) ?? 'reader';

      const url = `${DRIVE_BASE}/files/${encodeURIComponent(fileId)}/permissions`;
      const result = await googleWrite('POST', url, { role, type: 'user', emailAddress: email }, agentId, agentName, 'drive_share', { fileId, email, role });
      if (!result.ok) return `Error sharing file: ${result.error}`;
      return `File ${fileId} shared with ${email} as ${role}`;
    }

    case 'docs_create': {
      const title = args.title as string;
      const result = await googleWrite('POST', DOCS_BASE, { title }, agentId, agentName, 'docs_create', { title });
      if (!result.ok) return `Error creating document: ${result.error}`;

      const data = result.data as { documentId?: string };
      const docId = data?.documentId;

      // If initial content provided, append it
      if (docId && args.content) {
        const content = args.content as string;
        const batchUrl = `${DOCS_BASE}/${docId}:batchUpdate`;
        const writeResult = await googleWrite('POST', batchUrl, {
          requests: [{ insertText: { location: { index: 1 }, text: content } }],
        }, agentId, agentName, 'docs_edit', { documentId: docId, contentLength: content.length });

        if (!writeResult.ok) {
          return `Google Doc "${title}" created (ID: ${docId}) but failed to write content: ${writeResult.error}`;
        }
      }

      return `Google Doc "${title}" created${docId ? ` (ID: ${docId})` : ''}`;
    }

    case 'docs_edit': {
      const docId = args.document_id as string;
      const content = args.content as string;

      // Get document length to append at the end
      const docUrl = `${DOCS_BASE}/${encodeURIComponent(docId)}`;
      const doc = await googleRead(docUrl, agentId, agentName, 'docs_edit_fetch', { documentId: docId });
      if (!doc.ok) return `Error reading document: ${doc.error}`;

      const docData = doc.data as { body?: { content?: Array<{ endIndex?: number }> } };
      const endIndex = docData?.body?.content?.reduce((max, c) => Math.max(max, c.endIndex ?? 0), 0) ?? 1;

      const batchUrl = `${DOCS_BASE}/${encodeURIComponent(docId)}:batchUpdate`;
      const result = await googleWrite('POST', batchUrl, {
        requests: [{ insertText: { location: { index: Math.max(endIndex - 1, 1) }, text: '\n' + content } }],
      }, agentId, agentName, 'docs_edit', { documentId: docId, contentLength: content.length });

      if (!result.ok) return `Error editing document: ${result.error}`;
      return `Text appended to document ${docId}`;
    }

    case 'sheets_create': {
      const title = args.title as string;
      const result = await googleWrite('POST', SHEETS_BASE, { properties: { title } }, agentId, agentName, 'sheets_create', { title });
      if (!result.ok) return `Error creating spreadsheet: ${result.error}`;

      const data = result.data as { spreadsheetId?: string };
      const sheetId = data?.spreadsheetId;

      // Write headers if provided
      if (sheetId && args.headers) {
        const headers = args.headers as string[];
        const valuesUrl = `${SHEETS_BASE}/${sheetId}/values/Sheet1!A1?valueInputOption=USER_ENTERED`;
        await googleWrite('PUT', valuesUrl, { values: [headers] }, agentId, agentName, 'sheets_write', { spreadsheetId: sheetId, headers });
      }

      return `Spreadsheet "${title}" created${sheetId ? ` (ID: ${sheetId})` : ''}`;
    }

    case 'sheets_append': {
      const sheetId = args.spreadsheet_id as string;
      const range = (args.range as string) ?? 'Sheet1';
      const values = (args.values as string).split(',').map(v => v.trim());

      const url = `${SHEETS_BASE}/${encodeURIComponent(sheetId)}/values/${encodeURIComponent(range)}:append?valueInputOption=USER_ENTERED`;
      const result = await googleWrite('POST', url, { values: [values] }, agentId, agentName, 'sheets_append', { spreadsheetId: sheetId, range, valueCount: values.length });
      if (!result.ok) return `Error appending to spreadsheet: ${result.error}`;
      return `Row appended to spreadsheet ${sheetId}`;
    }

    case 'sheets_write': {
      const sheetId = args.spreadsheet_id as string;
      const range = args.range as string;
      const values = args.values as string[][];

      const url = `${SHEETS_BASE}/${encodeURIComponent(sheetId)}/values/${encodeURIComponent(range)}?valueInputOption=USER_ENTERED`;
      const result = await googleWrite('PUT', url, { values }, agentId, agentName, 'sheets_write', { spreadsheetId: sheetId, range, rows: values.length });
      if (!result.ok) return `Error writing to spreadsheet: ${result.error}`;
      return `Data written to ${range} in spreadsheet ${sheetId}`;
    }

    // slides_create → migrated to tools-slides.ts (see executeGoogleSlidesTool).

    default:
      return `Unknown Google write tool: ${name}`;
  }
}
