// ════════════════════════════════════════
// Google Workspace WRITE Tools
// Available to: primary agent ONLY
// ════════════════════════════════════════

import type { ToolDefinition } from '../agent/tools.js';
import { runGws, runGwsWrite, escapeForJson } from './client.js';
import { getPrimaryAgentName } from '../config/platform.js';

// ── Cached sender identity (agent name + email) ──

let cachedFromAddress: string | null = null;

function getFromAddress(): string | null {
  if (cachedFromAddress) return cachedFromAddress;

  // Get the Gmail address
  const result = runGws(`gmail users getProfile --params '{"userId": "me"}'`);
  if (!result.ok) return null;
  const email = (result.data as { emailAddress?: string })?.emailAddress;
  if (!email) return null;

  // Use the primary agent's name as the display name
  const name = getPrimaryAgentName();
  cachedFromAddress = name ? `${name} <${email}>` : email;

  return cachedFromAddress;
}

// ── Tool Definitions ──

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
  {
    name: 'slides_create',
    description: 'Create a new Google Slides presentation.',
    input_schema: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'Presentation title' },
      },
      required: ['title'],
    },
  },
];

// ── Tool Execution ──

export function executeGoogleWriteTool(
  name: string,
  args: Record<string, unknown>,
  agentId: string,
  agentName: string,
): string {
  switch (name) {
    case 'gmail_send': {
      const to = escapeForJson(args.to as string);
      const subject = escapeForJson(args.subject as string);
      const body = escapeForJson(args.body as string);
      let cmd = `gmail +send --to "${to}" --subject "${subject}" --body "${body}"`;
      const from = getFromAddress();
      if (from) cmd += ` --from "${escapeForJson(from)}"`;
      if (args.cc) cmd += ` --cc "${escapeForJson(args.cc as string)}"`;
      if (args.bcc) cmd += ` --bcc "${escapeForJson(args.bcc as string)}"`;

      const result = runGwsWrite(agentId, agentName, 'gmail_send', cmd, {
        to: args.to, subject: args.subject,
      });
      if (!result.ok) return `Error sending email: ${result.error}`;
      return `Email sent to ${args.to} with subject "${args.subject}"`;
    }

    case 'gmail_reply': {
      const messageId = escapeForJson(args.message_id as string);
      const body = escapeForJson(args.body as string);
      const replyAll = args.reply_all === true;
      const cmd = `gmail +${replyAll ? 'reply-all' : 'reply'} --message-id "${messageId}" --body "${body}"`;

      const result = runGwsWrite(agentId, agentName, 'gmail_reply', cmd, {
        messageId: args.message_id, replyAll,
      });
      if (!result.ok) return `Error replying to email: ${result.error}`;
      return `Reply sent${replyAll ? ' (to all)' : ''} to message ${args.message_id}`;
    }

    case 'gmail_forward': {
      const messageId = escapeForJson(args.message_id as string);
      const to = escapeForJson(args.to as string);
      let cmd = `gmail +forward --message-id "${messageId}" --to "${to}"`;
      if (args.body) cmd += ` --body "${escapeForJson(args.body as string)}"`;

      const result = runGwsWrite(agentId, agentName, 'gmail_forward', cmd, {
        messageId: args.message_id, to: args.to,
      });
      if (!result.ok) return `Error forwarding email: ${result.error}`;
      return `Email forwarded to ${args.to}`;
    }

    case 'gmail_label': {
      const messageId = escapeForJson(args.message_id as string);
      const addLabels = (args.add_labels as string[]) ?? [];
      const removeLabels = (args.remove_labels as string[]) ?? [];

      const body: Record<string, unknown> = { id: args.message_id };
      if (addLabels.length > 0) body.addLabelIds = addLabels;
      if (removeLabels.length > 0) body.removeLabelIds = removeLabels;

      const result = runGwsWrite(
        agentId, agentName, 'gmail_label',
        `gmail users messages modify --params '{"id": "${messageId}"}' --json '${JSON.stringify({ addLabelIds: addLabels, removeLabelIds: removeLabels })}'`,
        { messageId: args.message_id, addLabels, removeLabels },
      );
      if (!result.ok) return `Error modifying labels: ${result.error}`;
      return `Labels updated on message ${args.message_id}`;
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

      const result = runGwsWrite(
        agentId, agentName, 'calendar_create',
        `calendar events insert --params '{"calendarId": "primary"}' --json '${JSON.stringify(event).replace(/'/g, "'\\''")}'`,
        { title: args.title, start: args.start, end: args.end },
      );
      if (!result.ok) return `Error creating event: ${result.error}`;

      const data = result.data as { id?: string; htmlLink?: string };
      return `Calendar event "${args.title}" created${data?.id ? ` (ID: ${data.id})` : ''}${data?.htmlLink ? `\nLink: ${data.htmlLink}` : ''}`;
    }

    case 'calendar_update': {
      const eventId = escapeForJson(args.event_id as string);
      const patch: Record<string, unknown> = {};
      if (args.title) patch.summary = args.title;
      if (args.start) patch.start = { dateTime: args.start };
      if (args.end) patch.end = { dateTime: args.end };
      if (args.description) patch.description = args.description;

      const result = runGwsWrite(
        agentId, agentName, 'calendar_update',
        `calendar events patch --params '{"calendarId": "primary", "eventId": "${eventId}"}' --json '${JSON.stringify(patch).replace(/'/g, "'\\''")}'`,
        { eventId: args.event_id, ...patch },
      );
      if (!result.ok) return `Error updating event: ${result.error}`;
      return `Calendar event ${args.event_id} updated`;
    }

    case 'calendar_delete': {
      const eventId = escapeForJson(args.event_id as string);
      const result = runGwsWrite(
        agentId, agentName, 'calendar_delete',
        `calendar events delete --params '{"calendarId": "primary", "eventId": "${eventId}"}'`,
        { eventId: args.event_id },
      );
      if (!result.ok) return `Error deleting event: ${result.error}`;
      return `Calendar event ${args.event_id} deleted`;
    }

    case 'drive_upload': {
      const filePath = escapeForJson(args.file_path as string);
      let cmd = `drive +upload "${filePath}"`;
      if (args.name) cmd += ` --name "${escapeForJson(args.name as string)}"`;
      if (args.folder_id) cmd += ` --parent "${escapeForJson(args.folder_id as string)}"`;

      const result = runGwsWrite(agentId, agentName, 'drive_upload', cmd, {
        filePath: args.file_path, name: args.name, folderId: args.folder_id,
      });
      if (!result.ok) return `Error uploading file: ${result.error}`;

      const data = result.data as { id?: string; name?: string };
      return `File uploaded to Drive${data?.name ? `: ${data.name}` : ''}${data?.id ? ` (ID: ${data.id})` : ''}`;
    }

    case 'drive_share': {
      const fileId = escapeForJson(args.file_id as string);
      const email = escapeForJson(args.email as string);
      const role = (args.role as string) ?? 'reader';

      const result = runGwsWrite(
        agentId, agentName, 'drive_share',
        `drive permissions create --params '{"fileId": "${fileId}"}' --json '{"role": "${role}", "type": "user", "emailAddress": "${email}"}'`,
        { fileId: args.file_id, email: args.email, role },
      );
      if (!result.ok) return `Error sharing file: ${result.error}`;
      return `File ${args.file_id} shared with ${args.email} as ${role}`;
    }

    case 'docs_create': {
      const title = escapeForJson(args.title as string);
      const result = runGwsWrite(
        agentId, agentName, 'docs_create',
        `docs documents create --json '{"title": "${title}"}'`,
        { title: args.title },
      );
      if (!result.ok) return `Error creating document: ${result.error}`;

      const data = result.data as { documentId?: string; title?: string };
      const docId = data?.documentId;

      // If initial content provided, append it
      if (docId && args.content) {
        const content = escapeForJson(args.content as string);
        runGwsWrite(
          agentId, agentName, 'docs_edit',
          `docs +append --document-id "${docId}" --text "${content}"`,
          { documentId: docId, contentLength: (args.content as string).length },
        );
      }

      return `Google Doc "${args.title}" created${docId ? ` (ID: ${docId})` : ''}`;
    }

    case 'docs_edit': {
      const docId = escapeForJson(args.document_id as string);
      const content = escapeForJson(args.content as string);

      const result = runGwsWrite(
        agentId, agentName, 'docs_edit',
        `docs +append --document-id "${docId}" --text "${content}"`,
        { documentId: args.document_id, contentLength: (args.content as string).length },
      );
      if (!result.ok) return `Error editing document: ${result.error}`;
      return `Text appended to document ${args.document_id}`;
    }

    case 'sheets_create': {
      const title = escapeForJson(args.title as string);
      const result = runGwsWrite(
        agentId, agentName, 'sheets_create',
        `sheets spreadsheets create --json '{"properties": {"title": "${title}"}}'`,
        { title: args.title },
      );
      if (!result.ok) return `Error creating spreadsheet: ${result.error}`;

      const data = result.data as { spreadsheetId?: string };
      const sheetId = data?.spreadsheetId;

      // If headers provided, write them to the first row
      if (sheetId && args.headers) {
        const headers = args.headers as string[];
        const values = JSON.stringify([headers]);
        runGwsWrite(
          agentId, agentName, 'sheets_write',
          `sheets spreadsheets values update --params '{"spreadsheetId": "${sheetId}", "range": "Sheet1!A1", "valueInputOption": "USER_ENTERED"}' --json '{"values": ${values}}'`,
          { spreadsheetId: sheetId, headers },
        );
      }

      return `Spreadsheet "${args.title}" created${sheetId ? ` (ID: ${sheetId})` : ''}`;
    }

    case 'sheets_append': {
      const sheetId = escapeForJson(args.spreadsheet_id as string);
      const range = escapeForJson((args.range as string) ?? 'Sheet1');
      const values = (args.values as string).split(',').map(v => v.trim());

      const result = runGwsWrite(
        agentId, agentName, 'sheets_append',
        `sheets spreadsheets values append --params '{"spreadsheetId": "${sheetId}", "range": "${range}", "valueInputOption": "USER_ENTERED"}' --json '{"values": [${JSON.stringify(values)}]}'`,
        { spreadsheetId: args.spreadsheet_id, range, valueCount: values.length },
      );
      if (!result.ok) return `Error appending to spreadsheet: ${result.error}`;
      return `Row appended to spreadsheet ${args.spreadsheet_id}`;
    }

    case 'sheets_write': {
      const sheetId = escapeForJson(args.spreadsheet_id as string);
      const range = escapeForJson(args.range as string);
      const values = args.values as string[][];

      const result = runGwsWrite(
        agentId, agentName, 'sheets_write',
        `sheets spreadsheets values update --params '{"spreadsheetId": "${sheetId}", "range": "${range}", "valueInputOption": "USER_ENTERED"}' --json '{"values": ${JSON.stringify(values)}}'`,
        { spreadsheetId: args.spreadsheet_id, range, rows: values.length },
      );
      if (!result.ok) return `Error writing to spreadsheet: ${result.error}`;
      return `Data written to ${args.range} in spreadsheet ${args.spreadsheet_id}`;
    }

    case 'slides_create': {
      const title = escapeForJson(args.title as string);
      const result = runGwsWrite(
        agentId, agentName, 'slides_create',
        `slides presentations create --json '{"title": "${title}"}'`,
        { title: args.title },
      );
      if (!result.ok) return `Error creating presentation: ${result.error}`;

      const data = result.data as { presentationId?: string };
      return `Presentation "${args.title}" created${data?.presentationId ? ` (ID: ${data.presentationId})` : ''}`;
    }

    default:
      return `Unknown Google write tool: ${name}`;
  }
}
