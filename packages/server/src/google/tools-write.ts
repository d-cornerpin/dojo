// ════════════════════════════════════════
// Google Workspace WRITE Tools — Native REST API
// Available to: primary agent ONLY
// ════════════════════════════════════════

import type { ToolDefinition } from '../agent/tools.js';
import { googleRead, googleWrite } from './client.js';
import {
  type LocalAttachment,
  readLocalAttachments,
  partitionForGmail,
  formatSize,
  currentMonthFolderName,
  ATTACHMENTS_ROOT_FOLDER,
} from '../services/email-attachments.js';
import type { AccountSlot } from './auth.js';

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
    description: 'Send an email from the connected Google account. Supports attachments — pass an array of absolute local file paths. Files totalling up to 25MB go inline; anything over auto-uploads to your Google Drive (folder "DOJO Email Attachments/<YYYY-MM>") and the recipient gets a shareable link appended to the body.',
    input_schema: {
      type: 'object',
      properties: {
        to: { type: 'string', description: 'Recipient email address (or comma-separated list)' },
        subject: { type: 'string', description: 'Email subject line' },
        body: { type: 'string', description: 'Email body text' },
        cc: { type: 'string', description: 'CC recipients (comma-separated)' },
        bcc: { type: 'string', description: 'BCC recipients (comma-separated)' },
        attachments: { type: 'array', items: { type: 'string' }, description: 'Optional array of absolute local file paths to attach (e.g., ["/Users/me/.dojo/uploads/<agent-id>/report.pdf"]). Combined cap of 25MB inline; larger spill to Drive automatically.' },
      },
      required: ['to', 'subject', 'body'],
    },
  },
  {
    name: 'gmail_reply',
    description: 'Reply to an existing email thread. Supports attachments — same rules as gmail_send (25MB inline cap, overflow to Drive link).',
    input_schema: {
      type: 'object',
      properties: {
        message_id: { type: 'string', description: 'Message ID to reply to' },
        body: { type: 'string', description: 'Reply body text' },
        reply_all: { type: 'boolean', description: 'Reply to all recipients (default: false)' },
        attachments: { type: 'array', items: { type: 'string' }, description: 'Optional array of absolute local file paths to attach. Combined cap of 25MB inline; larger spill to Drive automatically.' },
      },
      required: ['message_id', 'body'],
    },
  },
  {
    name: 'gmail_forward',
    description: 'Forward an email to new recipients. The original message\'s attachments are preserved automatically. You can also add NEW attachments via the `attachments` parameter; same 25MB inline cap applies to the combined total (original + new), with Drive spillover for any overflow.',
    input_schema: {
      type: 'object',
      properties: {
        message_id: { type: 'string', description: 'Message ID to forward' },
        to: { type: 'string', description: 'Forward to this email address' },
        body: { type: 'string', description: 'Additional text to include' },
        attachments: { type: 'array', items: { type: 'string' }, description: 'Optional array of absolute local file paths to attach ALONGSIDE the original message\'s attachments. Combined cap of 25MB inline; larger spill to Drive automatically.' },
      },
      required: ['message_id', 'to'],
    },
  },
  {
    name: 'gmail_read_attachment',
    description:
      'Download an attachment from a Gmail message to local disk. Use gmail_list_attachments (or gmail_read, which lists them) to find the attachment_id first. Saves to ~/.dojo/uploads/<your-agent-id>/ by default; override with save_path. Returns the absolute path so you can pass it to file_read, show_to_user, etc.',
    input_schema: {
      type: 'object',
      properties: {
        message_id: { type: 'string', description: 'Gmail message ID' },
        attachment_id: { type: 'string', description: 'Attachment ID (from gmail_list_attachments or gmail_read)' },
        filename: { type: 'string', description: 'Filename to save as (defaults to "attachment-<id>.bin" if you don\'t know the original name)' },
        save_path: { type: 'string', description: 'Absolute path to save the file (defaults to ~/.dojo/uploads/<agent-id>/<filename>)' },
      },
      required: ['message_id', 'attachment_id'],
    },
    concurrency: 'serial',
    maxResultTokens: 500,
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
    description: 'Create a new calendar event. Defaults to your primary calendar; pass calendar_id to add to a shared calendar where you have write access (use calendar_list to find IDs and check accessRole).',
    input_schema: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'Event title' },
        start: { type: 'string', description: "Start datetime (ISO 8601, e.g., '2026-03-25T10:00:00')" },
        end: { type: 'string', description: 'End datetime (ISO 8601)' },
        description: { type: 'string', description: 'Event description' },
        attendees: { type: 'array', items: { type: 'string' }, description: 'Attendee email addresses' },
        location: { type: 'string', description: 'Event location' },
        calendar_id: { type: 'string', description: 'Calendar ID. Defaults to "primary" (your own).' },
      },
      required: ['title', 'start', 'end'],
    },
  },
  {
    name: 'calendar_update',
    description: 'Update an existing calendar event. Pass calendar_id if the event lives on a shared calendar.',
    input_schema: {
      type: 'object',
      properties: {
        event_id: { type: 'string', description: 'Calendar event ID' },
        title: { type: 'string', description: 'New event title' },
        start: { type: 'string', description: 'New start datetime' },
        end: { type: 'string', description: 'New end datetime' },
        description: { type: 'string', description: 'New event description' },
        calendar_id: { type: 'string', description: 'Calendar ID. Defaults to "primary".' },
      },
      required: ['event_id'],
    },
  },
  {
    name: 'calendar_delete',
    description: 'Delete a calendar event. Pass calendar_id if the event lives on a shared calendar.',
    input_schema: {
      type: 'object',
      properties: {
        event_id: { type: 'string', description: 'Calendar event ID to delete' },
        calendar_id: { type: 'string', description: 'Calendar ID. Defaults to "primary".' },
      },
      required: ['event_id'],
    },
  },
  {
    name: 'calendar_respond_invite',
    description: 'Accept, decline, or tentatively accept a Google Calendar meeting invite (RSVP to an event you were invited to). For accepting access to someone else\'s SHARED CALENDAR, use calendar_subscribe instead.',
    input_schema: {
      type: 'object',
      properties: {
        event_id: { type: 'string', description: 'Calendar event ID (from calendar_agenda or calendar_search)' },
        response: { type: 'string', enum: ['accepted', 'declined', 'tentative'], description: 'Your response to the invite' },
        attendee_email: { type: 'string', description: 'The email address you are RSVPing as. Required so we can find your row in the attendees array.' },
        comment: { type: 'string', description: 'Optional comment to set on your response (Google adds this to your attendee record).' },
        calendar_id: { type: 'string', description: 'Calendar ID where the event lives. Defaults to "primary".' },
      },
      required: ['event_id', 'response', 'attendee_email'],
    },
  },
  {
    name: 'calendar_subscribe',
    description: "Subscribe to a Google calendar that's been shared with you (adds it to your calendar list so calendar_list shows it and read/write tools can target it). The owner must have already shared the calendar with this account; this tool just accepts/registers that share. To find the calendar_id, look in the share-invitation email — it's typically the owner's email address or a specific calendar ID. For RSVPing to meeting invites use calendar_respond_invite instead.",
    input_schema: {
      type: 'object',
      properties: {
        calendar_id: { type: 'string', description: "ID of the calendar to subscribe to (often the owner's email address, e.g., 'someone@example.com', or a calendar ID like 'group.calendar.google.com')" },
      },
      required: ['calendar_id'],
    },
  },
  {
    name: 'calendar_unsubscribe',
    description: 'Remove a calendar from your calendar list (you stop seeing/syncing it). Does NOT delete the calendar — only removes the subscription. Re-subscribe later with calendar_subscribe.',
    input_schema: {
      type: 'object',
      properties: {
        calendar_id: { type: 'string', description: 'Calendar ID to unsubscribe from (from calendar_list).' },
      },
      required: ['calendar_id'],
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
    description: 'Share a Google Drive file or folder.\n\nFor "anyone with the link" sharing: pass audience: "anyone" — DO NOT pass "anyone" as the email value, that will fail. Email-share is only used when audience is "user" (the default).\n\nExamples:\n  • Share with a specific person:  { file_id, email: "alice@example.com", role: "reader" }\n  • Share via link (no email):     { file_id, audience: "anyone", role: "reader" }',
    input_schema: {
      type: 'object',
      properties: {
        file_id: { type: 'string', description: 'File or folder ID to share' },
        audience: {
          type: 'string',
          enum: ['user', 'anyone'],
          description: '"user" (default) shares with a specific email — `email` is required. "anyone" turns on link-share — anyone with the URL can access at the given role, no email needed. Aliases accepted: "public", "link", "everyone" all map to "anyone".',
        },
        email: { type: 'string', description: 'Email address to share with. Required when audience is "user" (the default). Ignored for "anyone". Do NOT pass "anyone"/"public"/"everyone" here — use the `audience` parameter instead.' },
        role: { type: 'string', description: "Permission level: 'reader' (default), 'writer', or 'commenter'." },
        discoverable: { type: 'boolean', description: 'Only relevant when audience is "anyone". When true, the file appears in Google Drive search results for anyone (broad public). Default false — the file is link-share only and not discoverable via search.' },
      },
      required: ['file_id'],
    },
  },
  {
    name: 'drive_delete',
    description: 'Delete a Google Drive file (or folder). Works for any Drive file: docs, sheets, slides, forms, uploads. Defaults to TRASH (recoverable for 30 days from the Drive trash UI). Pass permanent: true to skip trash and delete immediately — irreversible.\n\nNote: Forms are stored as Drive files. To delete a form, pass its form_id as file_id here. The Forms API itself has no delete endpoint.',
    input_schema: {
      type: 'object',
      properties: {
        file_id: { type: 'string', description: 'File or folder ID to delete (for forms, this is the form_id)' },
        permanent: { type: 'boolean', description: 'true = permanently delete (no recovery). false (default) = move to Drive trash (user can restore for 30 days).' },
      },
      required: ['file_id'],
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

// ── v2.7.1 multi-account: user_* send tool variants ──
//
// Mirror of the read-side USER_SLOT_READ_TOOLS pattern. Send/reply/forward
// from the user slot is gated by isEmailSendingEnabled('user') — see the
// executor for the refusal path. The toggle defaults OFF so connecting a
// personal Gmail doesn't silently grant the agent permission to send mail
// from it; the user has to flip the switch in Settings → Google → User.
const USER_SLOT_SEND_TOOLS: readonly string[] = ['gmail_send', 'gmail_reply', 'gmail_forward'];
for (const canonical of USER_SLOT_SEND_TOOLS) {
  const baseDef = googleWriteToolDefinitions.find(d => d.name === canonical);
  if (!baseDef) continue;
  googleWriteToolDefinitions.push({
    ...baseDef,
    name: `user_${canonical}`,
    description: `[USER'S Google account variant of \`${canonical}\`] ${baseDef.description}\n\nSends from the user's connected Google account (Settings → Google → User slot). Disabled by default — the user must turn on "Allow sending email" on the User slot card. If the toggle is off or the slot isn't connected, the tool returns a friendly error.`,
  });
}

// ── Helpers ──

function sanitizeFilename(name: string): string {
  // Strip quotes and CR/LF that would break the Content-Disposition header.
  return name.replace(/["\r\n]/g, '_');
}

// RFC 2047 encoded-word for non-ASCII header values (Subject, To, Cc names).
// Without this, an em-dash in a subject line shows up as mojibake in the
// recipient's inbox because RFC 2822 headers are ASCII-only by spec.
function encodeHeaderValue(value: string): string {
  if (/^[\x00-\x7F]*$/.test(value)) return value;
  return `=?utf-8?B?${Buffer.from(value, 'utf-8').toString('base64')}?=`;
}

function chunkBase64(b64: string, width = 76): string {
  return b64.match(new RegExp(`.{1,${width}}`, 'g'))?.join('\r\n') ?? b64;
}

function buildRfc2822Email(
  to: string,
  subject: string,
  body: string,
  options?: {
    cc?: string;
    bcc?: string;
    inReplyTo?: string;
    references?: string;
    threadId?: string;
    attachments?: readonly LocalAttachment[];
  },
): string {
  const headers: string[] = [];
  headers.push(`To: ${encodeHeaderValue(to)}`);
  headers.push(`Subject: ${encodeHeaderValue(subject)}`);
  if (options?.cc) headers.push(`Cc: ${encodeHeaderValue(options.cc)}`);
  if (options?.bcc) headers.push(`Bcc: ${encodeHeaderValue(options.bcc)}`);
  if (options?.inReplyTo) headers.push(`In-Reply-To: ${options.inReplyTo}`);
  if (options?.references) headers.push(`References: ${options.references}`);

  const attachments = options?.attachments ?? [];
  if (attachments.length === 0) {
    // Plain text — original behavior, kept identical for non-attachment sends.
    headers.push('Content-Type: text/plain; charset=utf-8');
    headers.push('');
    return Buffer.from(headers.join('\r\n') + '\r\n' + body).toString('base64url');
  }

  // multipart/mixed: one text/plain body part + one base64-encoded part per
  // attachment. Boundary is random per message — Gmail tolerates any boundary
  // that doesn't collide with the parts' contents.
  const boundary = `=_dojo_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 12)}`;
  headers.push('MIME-Version: 1.0');
  headers.push(`Content-Type: multipart/mixed; boundary="${boundary}"`);
  headers.push('');

  const parts: string[] = [];
  parts.push(`--${boundary}`);
  parts.push('Content-Type: text/plain; charset=utf-8');
  parts.push('Content-Transfer-Encoding: 7bit');
  parts.push('');
  parts.push(body);

  for (const att of attachments) {
    const safeName = sanitizeFilename(att.name);
    parts.push(`--${boundary}`);
    parts.push(`Content-Type: ${att.mimeType}; name="${safeName}"`);
    parts.push('Content-Transfer-Encoding: base64');
    parts.push(`Content-Disposition: attachment; filename="${safeName}"`);
    parts.push('');
    parts.push(chunkBase64(att.content.toString('base64')));
  }
  parts.push(`--${boundary}--`);

  return Buffer.from(headers.join('\r\n') + '\r\n' + parts.join('\r\n')).toString('base64url');
}

// ── Drive overflow helpers ──
//
// When user-supplied attachments exceed Gmail's 25MB inline ceiling, upload
// the overflow files to a stable folder in the agent's (or user's) Drive
// and append a shareable "anyone with link" URL to the message body. Folder
// layout: "DOJO Email Attachments/<YYYY-MM>/<filename>". Folders are
// created on demand if they don't exist.

type FolderResult = { ok: true; id: string } | { ok: false; error: string };

async function getOrCreateDriveFolder(
  name: string,
  parentId: string | undefined,
  agentId: string,
  agentName: string,
  slot: AccountSlot,
): Promise<FolderResult> {
  const escapedName = name.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
  const parentClause = parentId ? ` and '${parentId}' in parents` : " and 'root' in parents";
  const q = `name='${escapedName}' and mimeType='application/vnd.google-apps.folder' and trashed=false${parentClause}`;
  const searchUrl = `${DRIVE_BASE}/files?q=${encodeURIComponent(q)}&fields=files(id,name)&pageSize=1`;
  const lookup = await googleRead(
    searchUrl, agentId, agentName, 'gmail_attachment_folder_lookup',
    { name, parentId }, slot,
  );
  if (lookup.ok) {
    const data = lookup.data as { files?: Array<{ id?: string }> } | null;
    const existing = data?.files?.[0]?.id;
    if (existing) return { ok: true, id: existing };
  }

  const metadata: Record<string, unknown> = {
    name,
    mimeType: 'application/vnd.google-apps.folder',
  };
  if (parentId) metadata.parents = [parentId];
  const create = await googleWrite(
    'POST', `${DRIVE_BASE}/files?fields=id,name`,
    metadata,
    agentId, agentName, 'gmail_attachment_folder_create',
    { name, parentId },
    undefined, slot,
  );
  if (!create.ok) return { ok: false, error: create.error ?? 'unknown error creating folder' };
  const data = create.data as { id?: string } | null;
  if (!data?.id) return { ok: false, error: 'folder created but Drive returned no ID' };
  return { ok: true, id: data.id };
}

async function uploadAttachmentToDrive(
  att: LocalAttachment,
  agentId: string,
  agentName: string,
  slot: AccountSlot,
): Promise<{ ok: true; url: string; name: string } | { ok: false; error: string }> {
  const rootFolder = await getOrCreateDriveFolder(ATTACHMENTS_ROOT_FOLDER, undefined, agentId, agentName, slot);
  if (!rootFolder.ok) return { ok: false, error: `couldn't prepare Drive folder: ${rootFolder.error}` };
  const monthFolder = await getOrCreateDriveFolder(currentMonthFolderName(), rootFolder.id, agentId, agentName, slot);
  if (!monthFolder.ok) return { ok: false, error: `couldn't prepare Drive month folder: ${monthFolder.error}` };

  // Multipart upload: metadata JSON + raw bytes, mirrors drive_upload's pattern.
  const boundary = `---dojo-attach-${Date.now().toString(36)}---`;
  const metadata = { name: att.name, parents: [monthFolder.id] };
  const headerBlock = [
    `--${boundary}`,
    'Content-Type: application/json; charset=UTF-8',
    '',
    JSON.stringify(metadata),
    `--${boundary}`,
    `Content-Type: ${att.mimeType}`,
    '',
  ].join('\r\n');

  const bodyBuffer = Buffer.concat([
    Buffer.from(headerBlock + '\r\n'),
    att.content,
    Buffer.from(`\r\n--${boundary}--`),
  ]);

  const upload = await googleWrite(
    'POST',
    `${UPLOAD_BASE}/files?uploadType=multipart&fields=id,name,webViewLink`,
    bodyBuffer,
    agentId, agentName, 'gmail_attachment_drive_upload',
    { fileName: att.name, size: att.size, folderId: monthFolder.id },
    `multipart/related; boundary=${boundary}`,
    slot,
  );
  if (!upload.ok) return { ok: false, error: upload.error ?? 'unknown upload error' };
  const fileData = upload.data as { id?: string; name?: string; webViewLink?: string } | null;
  if (!fileData?.id) return { ok: false, error: 'upload succeeded but Drive returned no file ID' };

  // Create an "anyone with link, viewer" permission so the recipient can open
  // the file without signing in. Matches the user's policy preference.
  const share = await googleWrite(
    'POST',
    `${DRIVE_BASE}/files/${encodeURIComponent(fileData.id)}/permissions?supportsAllDrives=true&sendNotificationEmail=false`,
    { role: 'reader', type: 'anyone', allowFileDiscovery: false },
    agentId, agentName, 'gmail_attachment_drive_share',
    { fileId: fileData.id },
    undefined, slot,
  );
  if (!share.ok) return { ok: false, error: `uploaded but share failed: ${share.error}` };

  const url = fileData.webViewLink ?? `https://drive.google.com/file/d/${fileData.id}/view`;
  return { ok: true, url, name: fileData.name ?? att.name };
}

// ── Forward-attachment extraction ──
//
// Gmail's message payload is a tree of MIME parts. Attachment parts have a
// non-empty `filename` and either inline data (small) or an `attachmentId`
// that requires a separate fetch. Walk the tree, fetch each attachment's
// bytes, and return as LocalAttachment so the forward path can re-encode
// them into the outgoing multipart body.

type GmailMessagePart = {
  mimeType?: string;
  filename?: string;
  headers?: Array<{ name: string; value: string }>;
  body?: { attachmentId?: string; size?: number; data?: string };
  parts?: GmailMessagePart[];
};

function collectAttachmentParts(part: GmailMessagePart, out: GmailMessagePart[]): void {
  if (part.filename && part.filename.length > 0 && (part.body?.attachmentId || part.body?.data)) {
    out.push(part);
  }
  if (part.parts) {
    for (const child of part.parts) collectAttachmentParts(child, out);
  }
}

async function fetchOriginalAttachments(
  messageId: string,
  payload: GmailMessagePart,
  agentId: string,
  agentName: string,
  slot: AccountSlot,
): Promise<{ ok: true; attachments: LocalAttachment[] } | { ok: false; error: string }> {
  const parts: GmailMessagePart[] = [];
  collectAttachmentParts(payload, parts);

  const out: LocalAttachment[] = [];
  for (const part of parts) {
    const filename = part.filename ?? `attachment-${Date.now()}.bin`;
    const mimeType = part.mimeType ?? 'application/octet-stream';
    let bytes: Buffer | null = null;

    if (part.body?.data) {
      bytes = Buffer.from(part.body.data, 'base64url');
    } else if (part.body?.attachmentId) {
      const url = `${GMAIL_BASE}/messages/${encodeURIComponent(messageId)}/attachments/${encodeURIComponent(part.body.attachmentId)}`;
      const fetched = await googleRead(
        url, agentId, agentName, 'gmail_forward_attachment_fetch',
        { messageId, attachmentId: part.body.attachmentId, filename }, slot,
      );
      if (!fetched.ok) {
        return { ok: false, error: `failed to fetch forwarded attachment "${filename}": ${fetched.error}` };
      }
      const data = fetched.data as { data?: string } | null;
      if (!data?.data) {
        return { ok: false, error: `forwarded attachment "${filename}" has no downloadable data` };
      }
      bytes = Buffer.from(data.data, 'base64url');
    }

    if (!bytes) continue;
    out.push({
      path: '<original-message-attachment>',
      name: filename,
      size: bytes.length,
      mimeType,
      content: bytes,
    });
  }
  return { ok: true, attachments: out };
}

/**
 * Read and partition user-provided attachment paths for Gmail. Returns the
 * inline-eligible set and the overflow set that needs Drive upload. On any
 * file-read error, returns the error string so the caller can return it as
 * the tool result (fail-fast — no partial sends).
 */
function loadUserAttachmentsForGmail(
  paths: readonly string[] | undefined,
): { ok: true; attachments: LocalAttachment[] } | { ok: false; error: string } {
  if (!paths || paths.length === 0) return { ok: true, attachments: [] };
  return readLocalAttachments(paths);
}

// ── Tool Execution ──

const googleWriteToolDefByName = new Map(googleWriteToolDefinitions.map(t => [t.name, t]));

export async function executeGoogleWriteTool(
  name: string,
  args: Record<string, unknown>,
  agentId: string,
  agentName: string,
): Promise<string> {
  // v2.7.1 — strip user_ prefix on user-slot send tools and route via slot.
  // Only send/reply/forward currently have user_ variants (see
  // USER_SLOT_SEND_TOOLS above); other write tools still operate solely on
  // the agent slot.
  let slot: import('./auth.js').AccountSlot = 'agent';
  let canonicalName = name;
  if (name.startsWith('user_')) {
    slot = 'user';
    canonicalName = name.slice('user_'.length);
  }

  const { validateAgainstSchema } = await import('../agent/tool-helpers.js');
  const def = googleWriteToolDefByName.get(canonicalName);
  const schemaErr = validateAgainstSchema(canonicalName, def?.input_schema as Parameters<typeof validateAgainstSchema>[1], args);
  if (schemaErr) return schemaErr;

  // Send-permission gate. Refuse with a structured message that tells the
  // agent (and via logs, the user) exactly which switch to flip. Applies
  // to send, reply, and forward — and to both slots, since the toggle
  // defaults off everywhere.
  if (canonicalName === 'gmail_send' || canonicalName === 'gmail_reply' || canonicalName === 'gmail_forward') {
    const { isEmailSendingEnabled } = await import('./auth.js');
    if (!isEmailSendingEnabled(slot)) {
      const slotLabel = slot === 'user' ? "user's Google account" : "agent's Google account";
      return `Error: sending email from the ${slotLabel} is disabled. Open Settings → Google and turn on "Allow sending email" for the ${slot === 'user' ? 'User' : 'Agent'} slot, then try again.`;
    }
  }

  switch (canonicalName) {
    case 'gmail_send': {
      const to = args.to as string;
      const subject = args.subject as string;
      let body = args.body as string;

      const loaded = loadUserAttachmentsForGmail(args.attachments as string[] | undefined);
      if (!loaded.ok) return loaded.error;

      const { inline, overflow } = partitionForGmail(loaded.attachments);
      const overflowLines: string[] = [];
      for (const att of overflow) {
        const up = await uploadAttachmentToDrive(att, agentId, agentName, slot);
        if (!up.ok) return `Error uploading attachment "${att.name}" to Drive: ${up.error}`;
        overflowLines.push(`  • ${up.name} (${formatSize(att.size)}) — ${up.url}`);
      }
      if (overflowLines.length > 0) {
        body = `${body}\n\nAttached via Google Drive (file too large to inline):\n${overflowLines.join('\n')}`;
      }

      const raw = buildRfc2822Email(to, subject, body, {
        cc: args.cc as string | undefined,
        bcc: args.bcc as string | undefined,
        attachments: inline,
      });

      const result = await googleWrite('POST', `${GMAIL_BASE}/messages/send`, { raw }, agentId, agentName, 'gmail_send', { to, subject, slot, inlineAttachments: inline.length, driveAttachments: overflow.length }, undefined, slot);
      if (!result.ok) return `Error sending email: ${result.error}`;

      const attachSummary = (inline.length + overflow.length) === 0 ? '' :
        ` with ${inline.length} inline attachment(s)${overflow.length > 0 ? ` and ${overflow.length} Drive link(s)` : ''}`;
      return `Email sent to ${to} with subject "${subject}"${attachSummary}`;
    }

    case 'gmail_reply': {
      const messageId = args.message_id as string;
      let body = args.body as string;

      // Fetch original message to get thread ID and headers
      const origUrl = `${GMAIL_BASE}/messages/${encodeURIComponent(messageId)}?format=metadata&metadataHeaders=From&metadataHeaders=To&metadataHeaders=Subject&metadataHeaders=Message-ID`;
      const orig = await googleRead(origUrl, agentId, agentName, 'gmail_reply_fetch', { messageId, slot }, slot);
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

      const loaded = loadUserAttachmentsForGmail(args.attachments as string[] | undefined);
      if (!loaded.ok) return loaded.error;

      const { inline, overflow } = partitionForGmail(loaded.attachments);
      const overflowLines: string[] = [];
      for (const att of overflow) {
        const up = await uploadAttachmentToDrive(att, agentId, agentName, slot);
        if (!up.ok) return `Error uploading attachment "${att.name}" to Drive: ${up.error}`;
        overflowLines.push(`  • ${up.name} (${formatSize(att.size)}) — ${up.url}`);
      }
      if (overflowLines.length > 0) {
        body = `${body}\n\nAttached via Google Drive (file too large to inline):\n${overflowLines.join('\n')}`;
      }

      const raw = buildRfc2822Email(replyTo, replySubject, body, {
        inReplyTo: msgIdHeader,
        references: msgIdHeader,
        attachments: inline,
      });

      const result = await googleWrite('POST', `${GMAIL_BASE}/messages/send`, { raw, threadId: origData.threadId }, agentId, agentName, 'gmail_reply', { messageId, replyAll, slot, inlineAttachments: inline.length, driveAttachments: overflow.length }, undefined, slot);
      if (!result.ok) return `Error replying to email: ${result.error}`;

      const attachSummary = (inline.length + overflow.length) === 0 ? '' :
        ` with ${inline.length} inline attachment(s)${overflow.length > 0 ? ` and ${overflow.length} Drive link(s)` : ''}`;
      return `Reply sent${replyAll ? ' (to all)' : ''} to message ${messageId}${attachSummary}`;
    }

    case 'gmail_forward': {
      const messageId = args.message_id as string;
      const to = args.to as string;
      const additionalBody = (args.body as string) ?? '';

      // Fetch original message in full so we can preserve attachments.
      const origUrl = `${GMAIL_BASE}/messages/${encodeURIComponent(messageId)}?format=full`;
      const orig = await googleRead(origUrl, agentId, agentName, 'gmail_forward_fetch', { messageId, slot }, slot);
      if (!orig.ok) return `Error fetching original message: ${orig.error}`;

      const origData = orig.data as { payload?: GmailMessagePart };
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

      // Pull the original message's attachments so the forward preserves them
      // (Gmail web does this automatically; our prior implementation stripped
      // them by rebuilding only the text/plain body).
      let origAttachments: LocalAttachment[] = [];
      if (origData?.payload) {
        const fetched = await fetchOriginalAttachments(messageId, origData.payload, agentId, agentName, slot);
        if (!fetched.ok) return `Error preserving original attachments: ${fetched.error}`;
        origAttachments = fetched.attachments;
      }

      // Plus any new attachments the caller wants to add.
      const loaded = loadUserAttachmentsForGmail(args.attachments as string[] | undefined);
      if (!loaded.ok) return loaded.error;

      const allAttachments = [...origAttachments, ...loaded.attachments];
      const { inline, overflow } = partitionForGmail(allAttachments);

      let fwdBody = `${additionalBody}\n\n---------- Forwarded message ----------\nFrom: ${origFrom}\nSubject: ${origSubject}\n\n${origBody}`;

      const overflowLines: string[] = [];
      for (const att of overflow) {
        const up = await uploadAttachmentToDrive(att, agentId, agentName, slot);
        if (!up.ok) return `Error uploading attachment "${att.name}" to Drive: ${up.error}`;
        overflowLines.push(`  • ${up.name} (${formatSize(att.size)}) — ${up.url}`);
      }
      if (overflowLines.length > 0) {
        fwdBody += `\n\nAttached via Google Drive (file too large to inline):\n${overflowLines.join('\n')}`;
      }

      const fwdSubject = origSubject.startsWith('Fwd:') ? origSubject : `Fwd: ${origSubject}`;
      const raw = buildRfc2822Email(to, fwdSubject, fwdBody, { attachments: inline });
      const result = await googleWrite('POST', `${GMAIL_BASE}/messages/send`, { raw }, agentId, agentName, 'gmail_forward', { messageId, to, slot, inlineAttachments: inline.length, driveAttachments: overflow.length, preservedFromOriginal: origAttachments.length }, undefined, slot);
      if (!result.ok) return `Error forwarding email: ${result.error}`;

      const attachSummary = allAttachments.length === 0 ? '' :
        ` (${inline.length} inline, ${overflow.length} via Drive link; ${origAttachments.length} preserved from original)`;
      return `Email forwarded to ${to}${attachSummary}`;
    }

    case 'gmail_read_attachment': {
      const messageId = args.message_id as string;
      const attachmentId = args.attachment_id as string;
      const url = `${GMAIL_BASE}/messages/${encodeURIComponent(messageId)}/attachments/${encodeURIComponent(attachmentId)}`;
      // googleWrite is fine here for the read — it just makes an authenticated GET.
      // Using googleRead module to avoid quirky write-side audit semantics.
      const { googleRead } = await import('./client.js');
      const result = await googleRead(url, agentId, agentName, 'gmail_read_attachment', { messageId, attachmentId });
      if (!result.ok) return `Error fetching attachment: ${result.error}`;
      const att = result.data as { size?: number; data?: string };
      if (!att?.data) return 'Error: attachment has no downloadable data (may be inline or removed).';

      const fs = await import('node:fs');
      const os = await import('node:os');
      const nodePath = await import('node:path');

      const filenameArg = (args.filename as string | undefined) ?? `attachment-${attachmentId.slice(0, 12)}.bin`;
      const defaultDir = nodePath.join(os.homedir(), '.dojo', 'uploads', agentId);
      fs.mkdirSync(defaultDir, { recursive: true });
      const outPath = (args.save_path as string | undefined) ?? nodePath.join(defaultDir, filenameArg);

      const content = Buffer.from(att.data, 'base64url');
      fs.writeFileSync(outPath, content);
      return `Attachment saved to ${outPath} (${Math.round(content.length / 1024)}KB). Use file_read or show_to_user with this path.`;
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
      const calendarId = (args.calendar_id as string | undefined) ?? 'primary';
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

      const url = `${CALENDAR_BASE}/calendars/${encodeURIComponent(calendarId)}/events`;
      const result = await googleWrite('POST', url, event, agentId, agentName, 'calendar_create', { title: args.title, start: args.start, end: args.end, calendarId });
      if (!result.ok) return `Error creating event: ${result.error}`;

      const data = result.data as { id?: string; htmlLink?: string };
      return `Calendar event "${args.title}" created${data?.id ? ` (ID: ${data.id})` : ''}${data?.htmlLink ? `\nLink: ${data.htmlLink}` : ''}`;
    }

    case 'calendar_update': {
      const eventId = args.event_id as string;
      const calendarId = (args.calendar_id as string | undefined) ?? 'primary';
      const patch: Record<string, unknown> = {};
      if (args.title) patch.summary = args.title;
      if (args.start) patch.start = { dateTime: args.start };
      if (args.end) patch.end = { dateTime: args.end };
      if (args.description) patch.description = args.description;

      const url = `${CALENDAR_BASE}/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(eventId)}`;
      const result = await googleWrite('PATCH', url, patch, agentId, agentName, 'calendar_update', { eventId, calendarId, ...patch });
      if (!result.ok) return `Error updating event: ${result.error}`;
      return `Calendar event ${eventId} updated`;
    }

    case 'calendar_delete': {
      const eventId = args.event_id as string;
      const calendarId = (args.calendar_id as string | undefined) ?? 'primary';
      const url = `${CALENDAR_BASE}/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(eventId)}`;
      const result = await googleWrite('DELETE', url, undefined, agentId, agentName, 'calendar_delete', { eventId, calendarId });
      if (!result.ok) return `Error deleting event: ${result.error}`;
      return `Calendar event ${eventId} deleted`;
    }

    case 'calendar_respond_invite': {
      const eventId = args.event_id as string;
      const response = args.response as 'accepted' | 'declined' | 'tentative';
      const attendeeEmail = (args.attendee_email as string).toLowerCase();
      const comment = args.comment as string | undefined;
      const calendarId = (args.calendar_id as string | undefined) ?? 'primary';

      // Read the event so we can find the attendee row to update.
      // Google's PATCH replaces the whole attendees array, so we need to
      // round-trip the existing list with our row modified.
      const readUrl = `${CALENDAR_BASE}/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(eventId)}`;
      const { googleRead } = await import('./client.js');
      const readResult = await googleRead(readUrl, agentId, agentName, 'calendar_respond_invite:read', { eventId, calendarId });
      if (!readResult.ok) return `Error fetching event: ${readResult.error}`;

      const event = readResult.data as { attendees?: Array<{ email?: string; responseStatus?: string; comment?: string }> };
      const attendees = event.attendees ?? [];
      const idx = attendees.findIndex(a => (a.email ?? '').toLowerCase() === attendeeEmail);
      if (idx < 0) {
        return `Error: ${args.attendee_email} is not on this event's attendee list. Confirm the email or check whether the invite is for a different account.`;
      }
      attendees[idx] = {
        ...attendees[idx],
        responseStatus: response,
        ...(comment ? { comment } : {}),
      };

      const url = `${CALENDAR_BASE}/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(eventId)}?sendUpdates=all`;
      const result = await googleWrite('PATCH', url, { attendees }, agentId, agentName, 'calendar_respond_invite', { eventId, response, attendeeEmail, calendarId });
      if (!result.ok) return `Error responding to invite: ${result.error}`;
      return `Responded "${response}" to event ${eventId} as ${args.attendee_email}.`;
    }

    case 'calendar_subscribe': {
      const calendarId = args.calendar_id as string;
      const url = `${CALENDAR_BASE}/users/me/calendarList`;
      const result = await googleWrite('POST', url, { id: calendarId }, agentId, agentName, 'calendar_subscribe', { calendarId });
      if (!result.ok) return `Error subscribing to calendar: ${result.error}`;
      const data = result.data as { id?: string; summary?: string; accessRole?: string };
      return `Subscribed to "${data?.summary ?? calendarId}" (access: ${data?.accessRole ?? 'unknown'}). It now appears in calendar_list.`;
    }

    case 'calendar_unsubscribe': {
      const calendarId = args.calendar_id as string;
      const url = `${CALENDAR_BASE}/users/me/calendarList/${encodeURIComponent(calendarId)}`;
      const result = await googleWrite('DELETE', url, undefined, agentId, agentName, 'calendar_unsubscribe', { calendarId });
      if (!result.ok) return `Error unsubscribing: ${result.error}`;
      return `Unsubscribed from calendar ${calendarId}. The calendar itself was not deleted.`;
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

      // Pass the multipart body as a raw Buffer. Pre-2026-04-30 this called
      // .toString('base64') here, sending a base64 string with content-type
      // multipart/related — which Google rejects with 400 because it expects
      // raw bytes for the multipart payload, not a base64 wrapper. The
      // Google client now passes Uint8Array/Buffer through to fetch as-is.
      const result = await googleWrite(
        'POST',
        `${UPLOAD_BASE}/files?uploadType=multipart`,
        bodyBuffer,
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
      const role = (args.role as string) ?? 'reader';
      if (!['reader', 'writer', 'commenter'].includes(role)) {
        return `Error: role must be 'reader', 'writer', or 'commenter' (got ${role}).`;
      }

      // Resolve audience with alias support. Pre-fix, agents that didn't
      // notice the new `audience` param tried to invoke link-share by
      // passing "anyone" as the email value, which routed through the
      // user-share branch and Google rejected with a confusing
      // "emailAddress is invalid" error. Now we accept common synonyms
      // for "anyone" and ALSO auto-correct when an audience-keyword shows
      // up in the email slot — better than failing with a cryptic message.
      const ANYONE_ALIASES = new Set(['anyone', 'public', 'link', 'everyone', 'world', '*']);
      let audience = ((args.audience as string | undefined) ?? '').toLowerCase().trim();
      if (ANYONE_ALIASES.has(audience)) audience = 'anyone';

      const rawEmail = (args.email as string | undefined)?.trim() ?? '';
      const emailLooksLikeAudienceKeyword = rawEmail.length > 0 && !rawEmail.includes('@') && ANYONE_ALIASES.has(rawEmail.toLowerCase());

      // If audience wasn't set explicitly but `email` carries an audience
      // keyword, treat it as a link-share request rather than failing.
      if (!audience && emailLooksLikeAudienceKeyword) {
        audience = 'anyone';
      }
      if (!audience) audience = 'user';

      if (!['user', 'anyone'].includes(audience)) {
        return `Error: audience must be 'user' or 'anyone' (got '${audience}'). Aliases accepted: public/link/everyone → anyone.`;
      }

      const url = `${DRIVE_BASE}/files/${encodeURIComponent(fileId)}/permissions?supportsAllDrives=true&sendNotificationEmail=false`;

      if (audience === 'anyone') {
        // "Anyone with the link" public share. Pre-2026-04-30 drive_share
        // only supported per-email sharing, which forced agents to punt
        // back to the user when delivering decks to clients whose email
        // wasn't known. Now they can just enable link-share and send the URL.
        const discoverable = args.discoverable === true;
        const result = await googleWrite(
          'POST', url,
          { role, type: 'anyone', allowFileDiscovery: discoverable },
          agentId, agentName, 'drive_share',
          { fileId, audience: 'anyone', role, discoverable },
        );
        if (!result.ok) return `Error sharing file: ${result.error}`;
        const accessNote = discoverable ? 'discoverable via Drive search' : 'link-share only (not discoverable)';
        const correctedNote = emailLooksLikeAudienceKeyword && !args.audience
          ? ` (Note: I auto-corrected your call — pass audience: "anyone" rather than email: "${rawEmail}" next time.)`
          : '';
        return `File ${fileId} is now accessible to anyone with the link as ${role} (${accessNote}). Share the file's URL directly — no email required.${correctedNote}`;
      }

      // Default: share with a specific email.
      if (!rawEmail) {
        return `Error: email is required when audience is "user". Either pass a real email address, or set audience: "anyone" to enable link-share (no email required).`;
      }
      if (!rawEmail.includes('@')) {
        return `Error: "${rawEmail}" is not a valid email address. For link-share use audience: "anyone" instead — DO NOT pass "anyone"/"public"/"everyone" as the email value.`;
      }
      const result = await googleWrite(
        'POST', url,
        { role, type: 'user', emailAddress: rawEmail },
        agentId, agentName, 'drive_share',
        { fileId, email: rawEmail, role },
      );
      if (!result.ok) return `Error sharing file: ${result.error}`;
      return `File ${fileId} shared with ${rawEmail} as ${role}.`;
    }

    case 'drive_delete': {
      const fileId = args.file_id as string;
      if (!fileId) return 'Error: file_id is required';
      const permanent = args.permanent === true;
      // Drive API: DELETE /files/{id} permanently removes; PATCH /files/{id}
      // with {trashed: true} sends to trash (recoverable for 30 days).
      // Default to trash so a wrong-id mistake doesn't destroy data outright.
      if (permanent) {
        const result = await googleWrite(
          'DELETE',
          `https://www.googleapis.com/drive/v3/files/${fileId}`,
          undefined,
          agentId, agentName, 'drive_delete',
          { fileId, permanent: true },
        );
        if (!result.ok) return `Error permanently deleting file: ${result.error}`;
        return `File ${fileId} permanently deleted.`;
      } else {
        const result = await googleWrite(
          'PATCH',
          `https://www.googleapis.com/drive/v3/files/${fileId}`,
          { trashed: true },
          agentId, agentName, 'drive_delete',
          { fileId, permanent: false },
        );
        if (!result.ok) return `Error trashing file: ${result.error}`;
        return `File ${fileId} moved to Drive trash (recoverable for 30 days).`;
      }
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
