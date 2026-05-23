// ════════════════════════════════════════
// Microsoft 365 WRITE Tools
// Available to: primary agent ONLY
// ════════════════════════════════════════

import type { ToolDefinition } from '../agent/tools.js';
import { msGraphRead, msGraphWrite, calendarPrefix, drivePrefix } from './client.js';
import { getPrimaryAgentName } from '../config/platform.js';
import {
  type LocalAttachment,
  readLocalAttachments,
  partitionForOutlook,
  formatSize,
  currentMonthFolderName,
  ATTACHMENTS_ROOT_FOLDER,
} from '../services/email-attachments.js';
import type { AccountSlot } from './auth.js';

// ── Tool Definitions ──

export const microsoftWriteToolDefinitions: ToolDefinition[] = [
  {
    name: 'outlook_send',
    description: 'Send an email from the connected Microsoft account (Outlook). Supports attachments — pass an array of absolute local file paths. Files ≤3MB attach inline; anything larger auto-uploads to OneDrive (folder "DOJO Email Attachments/<YYYY-MM>") and the recipient gets a shareable link appended to the body.',
    input_schema: {
      type: 'object',
      properties: {
        to: { type: 'string', description: 'Recipient email address (or comma-separated list)' },
        subject: { type: 'string', description: 'Email subject line' },
        body: { type: 'string', description: 'Email body text' },
        cc: { type: 'string', description: 'CC recipients (comma-separated)' },
        attachments: { type: 'array', items: { type: 'string' }, description: 'Optional array of absolute local file paths to attach. Files ≤3MB inline; larger spill to OneDrive link automatically.' },
      },
      required: ['to', 'subject', 'body'],
    },
  },
  {
    name: 'outlook_reply',
    description: 'Reply to an existing Outlook email thread. Supports attachments — same rules as outlook_send (3MB inline threshold per file, overflow to OneDrive link).',
    input_schema: {
      type: 'object',
      properties: {
        message_id: { type: 'string', description: 'Message ID to reply to' },
        body: { type: 'string', description: 'Reply body text' },
        reply_all: { type: 'boolean', description: 'Reply to all recipients (default: false)' },
        attachments: { type: 'array', items: { type: 'string' }, description: 'Optional array of absolute local file paths to attach. Files ≤3MB inline; larger spill to OneDrive link automatically.' },
      },
      required: ['message_id', 'body'],
    },
  },
  {
    name: 'outlook_forward',
    description: 'Forward an Outlook email to new recipients. The original message\'s attachments are preserved automatically by Graph. You can also add NEW attachments via the `attachments` parameter; same 3MB per-file threshold applies (overflow → OneDrive link).',
    input_schema: {
      type: 'object',
      properties: {
        message_id: { type: 'string', description: 'Message ID to forward' },
        to: { type: 'string', description: 'Forward to this email address' },
        body: { type: 'string', description: 'Additional text to include' },
        attachments: { type: 'array', items: { type: 'string' }, description: 'Optional array of absolute local file paths to attach IN ADDITION to the original message\'s attachments (which Graph preserves automatically). Files ≤3MB inline; larger spill to OneDrive link.' },
      },
      required: ['message_id', 'to'],
    },
  },
  {
    name: 'calendar_create_ms',
    description: 'Create a new Microsoft Calendar event. Defaults to your default calendar; pass calendar_id to add to a shared calendar where you have write access (use calendar_list_ms to find IDs and check canEdit).',
    input_schema: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'Event title' },
        start: { type: 'string', description: "Start datetime (ISO 8601, e.g., '2026-03-25T10:00:00')" },
        end: { type: 'string', description: 'End datetime (ISO 8601)' },
        description: { type: 'string', description: 'Event description' },
        attendees: { type: 'array', items: { type: 'string' }, description: 'Attendee email addresses' },
        location: { type: 'string', description: 'Event location' },
        calendar_id: { type: 'string', description: 'Calendar to target. Two forms: (1) a calendar UUID from calendar_list_ms; (2) an email address for direct delegate access to a shared calendar (e.g., "owner@example.com"). Defaults to your default calendar.' },
      },
      required: ['title', 'start', 'end'],
    },
  },
  {
    name: 'calendar_update_ms',
    description: 'Update an existing Microsoft Calendar event. Pass calendar_id if the event lives on a shared calendar.',
    input_schema: {
      type: 'object',
      properties: {
        event_id: { type: 'string', description: 'Calendar event ID' },
        title: { type: 'string', description: 'New event title' },
        start: { type: 'string', description: 'New start datetime' },
        end: { type: 'string', description: 'New end datetime' },
        description: { type: 'string', description: 'New description' },
        calendar_id: { type: 'string', description: 'Calendar to target. Two forms: (1) a calendar UUID from calendar_list_ms; (2) an email address for direct delegate access to a shared calendar (e.g., "owner@example.com"). Defaults to your default calendar.' },
      },
      required: ['event_id'],
    },
  },
  {
    name: 'calendar_delete_ms',
    description: 'Delete a Microsoft Calendar event. Pass calendar_id if the event lives on a shared calendar.',
    input_schema: {
      type: 'object',
      properties: {
        event_id: { type: 'string', description: 'Calendar event ID to delete' },
        calendar_id: { type: 'string', description: 'Calendar to target. Two forms: (1) a calendar UUID from calendar_list_ms; (2) an email address for direct delegate access to a shared calendar (e.g., "owner@example.com"). Defaults to your default calendar.' },
      },
      required: ['event_id'],
    },
  },
  {
    name: 'onedrive_create_folder',
    description: 'Create a new folder. Defaults to your personal OneDrive root; pass drive_id to create in a shared OneDrive item or SharePoint document library.',
    input_schema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Folder name to create' },
        parent_folder_id: { type: 'string', description: 'ID of the parent folder to create inside (omit to create in the drive root)' },
        drive_id: { type: 'string', description: 'Drive to create the folder in. Defaults to your personal OneDrive.' },
      },
      required: ['name'],
    },
  },
  {
    name: 'onedrive_upload',
    description: 'Upload a file. Defaults to your personal OneDrive; pass drive_id to upload to a shared drive or SharePoint library. Handles files of any size using resumable upload sessions.',
    input_schema: {
      type: 'object',
      properties: {
        file_path: { type: 'string', description: 'Local file path to upload' },
        name: { type: 'string', description: 'Name for the file in OneDrive (defaults to local filename)' },
        folder_id: { type: 'string', description: 'Upload to a specific folder (omit for the drive root)' },
        drive_id: { type: 'string', description: 'Drive to upload to. Defaults to your personal OneDrive.' },
      },
      required: ['file_path'],
    },
  },
  {
    name: 'teams_create_chat',
    description: 'Create a new Teams 1:1 or group chat. Returns the chat_id so you can immediately send a message with teams_send_message. Use this when you need to message someone for the first time and do not have a chat_id yet. Requires a Microsoft work/school account (Entra ID).',
    input_schema: {
      type: 'object',
      properties: {
        members: {
          type: 'array',
          items: { type: 'string' },
          description: 'Email address(es) of the person or people to add to the chat. For a 1:1 chat, provide exactly one email. For a group chat, provide two or more.',
        },
        topic: {
          type: 'string',
          description: 'Chat topic/name (required for group chats, optional for 1:1)',
        },
      },
      required: ['members'],
    },
  },
  {
    name: 'teams_send_message',
    description: 'Send a message to a Teams chat. Requires a Microsoft work/school account (Entra ID). Not available on personal Microsoft accounts. If you do not have a chat_id, use teams_create_chat first.',
    input_schema: {
      type: 'object',
      properties: {
        chat_id: { type: 'string', description: 'Teams chat ID (from teams_read_messages or teams_create_chat)' },
        message: { type: 'string', description: 'Message text to send' },
      },
      required: ['chat_id', 'message'],
    },
  },
  {
    name: 'onedrive_share',
    description: 'Share a file or folder with someone via a sharing link or direct permission. Defaults to your personal OneDrive; pass drive_id to share an item on a shared drive or SharePoint library (subject to your permissions there).',
    input_schema: {
      type: 'object',
      properties: {
        file_id: { type: 'string', description: 'File or folder ID to share' },
        email: { type: 'string', description: 'Email address to share with (omit for anonymous link)' },
        role: { type: 'string', enum: ['read', 'write'], description: "Permission level (default: 'read')" },
        type: { type: 'string', enum: ['link', 'invite'], description: "Share method: 'link' for sharing link, 'invite' for direct email invite (default: 'link')" },
        drive_id: { type: 'string', description: 'Drive the item lives on. Defaults to your personal OneDrive.' },
      },
      required: ['file_id'],
    },
  },
  {
    name: 'outlook_mark_read',
    description: 'Mark an Outlook email as read or unread.',
    input_schema: {
      type: 'object',
      properties: {
        message_id: { type: 'string', description: 'Outlook message ID' },
        is_read: { type: 'boolean', description: 'true to mark as read, false to mark as unread (default: true)' },
      },
      required: ['message_id'],
    },
  },
  {
    name: 'outlook_delete',
    description: 'Delete an Outlook email (moves to Deleted Items, not permanent).',
    input_schema: {
      type: 'object',
      properties: {
        message_id: { type: 'string', description: 'Outlook message ID to delete' },
      },
      required: ['message_id'],
    },
  },
  {
    name: 'outlook_download_attachment',
    description: 'Download an email attachment to local disk. Use outlook_list_attachments first to get the attachment ID.',
    input_schema: {
      type: 'object',
      properties: {
        message_id: { type: 'string', description: 'Outlook message ID' },
        attachment_id: { type: 'string', description: 'Attachment ID (from outlook_list_attachments)' },
        save_path: { type: 'string', description: 'Local path to save the file (defaults to ~/Downloads/{filename})' },
      },
      required: ['message_id', 'attachment_id'],
    },
  },
  {
    name: 'calendar_respond_invite_ms',
    description: 'Accept, decline, or tentatively accept a Microsoft Calendar meeting invite (RSVP to an event you were invited to). For accepting access to someone else\'s SHARED CALENDAR, use calendar_accept_share_ms instead.',
    input_schema: {
      type: 'object',
      properties: {
        event_id: { type: 'string', description: 'Calendar event ID (from calendar_agenda_ms or calendar_search_ms)' },
        response: { type: 'string', enum: ['accept', 'decline', 'tentative'], description: 'Your response to the invite' },
        comment: { type: 'string', description: 'Optional message to include with your response' },
      },
      required: ['event_id', 'response'],
    },
  },
  {
    name: 'calendar_accept_share_ms',
    description: "Accept a pending calendar-sharing invitation email (someone shared their calendar with you). Use calendar_share_invites_ms first to find the message_id of the pending invite. After accepting, the shared calendar appears in calendar_list_ms and can be operated on via the calendar_id parameter on the other Microsoft calendar tools. Microsoft Graph's programmatic acceptance support is limited — if this tool returns an unsupported error, the user will need to accept via the Outlook web/desktop UI; once accepted there, the calendar is accessible via the same tools.",
    input_schema: {
      type: 'object',
      properties: {
        message_id: { type: 'string', description: 'ID of the calendar-share invitation email (from calendar_share_invites_ms)' },
      },
      required: ['message_id'],
    },
  },
  {
    name: 'onedrive_delete',
    description: 'Delete a file or folder. Defaults to your personal OneDrive; pass drive_id for a shared drive or SharePoint library.',
    input_schema: {
      type: 'object',
      properties: {
        file_id: { type: 'string', description: 'File or folder ID to delete' },
        drive_id: { type: 'string', description: 'Drive the item lives on. Defaults to your personal OneDrive.' },
      },
      required: ['file_id'],
    },
  },
  {
    name: 'onedrive_move',
    description: 'Move or rename a file or folder. Provide new_name to rename, new_parent_id to move, or both. Defaults to your personal OneDrive.',
    input_schema: {
      type: 'object',
      properties: {
        file_id: { type: 'string', description: 'File or folder ID' },
        new_name: { type: 'string', description: 'New name for the item (omit to keep current name)' },
        new_parent_id: { type: 'string', description: 'ID of the destination folder (omit to keep in current location)' },
        drive_id: { type: 'string', description: 'Drive the item lives on. Defaults to your personal OneDrive.' },
      },
      required: ['file_id'],
    },
  },
  {
    name: 'onedrive_upload_batch',
    description: 'Upload multiple files in a single tool call. Defaults to your personal OneDrive; pass drive_id to upload to a shared drive or SharePoint library. Handles files of any size. Returns a summary of successes and failures.',
    input_schema: {
      type: 'object',
      properties: {
        file_paths: {
          type: 'array',
          items: { type: 'string' },
          description: 'Array of local file paths to upload',
        },
        folder_id: { type: 'string', description: 'Upload to a specific folder ID (omit for the drive root)' },
        drive_id: { type: 'string', description: 'Drive to upload to. Defaults to your personal OneDrive.' },
      },
      required: ['file_paths'],
    },
  },
  {
    name: 'online_meeting_create',
    description: "Create a Teams online meeting and get a join URL. Use this when you need to give someone a Teams link — typically right before calendar_create_ms so the meeting URL can be added to the event description. Subject, start, and end are required.",
    input_schema: {
      type: 'object',
      properties: {
        subject: { type: 'string', description: 'Meeting subject / title' },
        start: { type: 'string', description: "Start datetime (ISO 8601, e.g., '2026-05-10T14:00:00Z')" },
        end: { type: 'string', description: 'End datetime (ISO 8601)' },
      },
      required: ['subject', 'start', 'end'],
    },
  },
  {
    name: 'online_meeting_update',
    description: 'Update a Teams online meeting (subject, start, end). The join URL stays the same.',
    input_schema: {
      type: 'object',
      properties: {
        meeting_id: { type: 'string', description: 'Online meeting ID (from online_meeting_create or online_meeting_get)' },
        subject: { type: 'string', description: 'New subject' },
        start: { type: 'string', description: 'New start datetime (ISO 8601)' },
        end: { type: 'string', description: 'New end datetime (ISO 8601)' },
      },
      required: ['meeting_id'],
    },
  },
  {
    name: 'online_meeting_delete',
    description: 'Delete a Teams online meeting. The join URL becomes invalid. Use this when canceling a meeting you previously created with online_meeting_create.',
    input_schema: {
      type: 'object',
      properties: {
        meeting_id: { type: 'string', description: 'Online meeting ID to delete' },
      },
      required: ['meeting_id'],
    },
  },
  {
    name: 'teams_send_channel_message',
    description: 'Post a message to a Microsoft Teams channel. Requires Entra ID. Use teams_list_teams then teams_list_channels to get the IDs.',
    input_schema: {
      type: 'object',
      properties: {
        team_id: { type: 'string', description: 'Team ID (from teams_list_teams)' },
        channel_id: { type: 'string', description: 'Channel ID (from teams_list_channels)' },
        message: { type: 'string', description: 'Message text to post' },
      },
      required: ['team_id', 'channel_id', 'message'],
    },
  },
];

// ── v2.7.1 multi-account: user_* send tool variants ──
// Mirrors USER_SLOT_SEND_TOOLS in google/tools-write.ts. Gated by
// isMsEmailSendingEnabled('user') in the executor below. Off by default.
const USER_SLOT_SEND_TOOLS: readonly string[] = ['outlook_send', 'outlook_reply', 'outlook_forward'];
for (const canonical of USER_SLOT_SEND_TOOLS) {
  const baseDef = microsoftWriteToolDefinitions.find(d => d.name === canonical);
  if (!baseDef) continue;
  microsoftWriteToolDefinitions.push({
    ...baseDef,
    name: `user_${canonical}`,
    description: `[USER'S Microsoft account variant of \`${canonical}\`] ${baseDef.description}\n\nSends from the user's connected Microsoft account (Settings → Microsoft → User slot). Disabled by default — the user must turn on "Allow sending email" on the User slot card. If the toggle is off or the slot isn't connected, the tool returns a friendly error.`,
  });
}

// ── Helpers ──

function parseRecipients(str: string): Array<{ emailAddress: { address: string } }> {
  return str.split(',').map(s => s.trim()).filter(Boolean).map(address => ({
    emailAddress: { address },
  }));
}

// ── Attachment helpers ──
//
// Graph's `attachments` array on a sendMail/reply/forward message accepts
// fileAttachment items with base64-encoded `contentBytes`. Practical
// per-message limit is around 4MB before the JSON payload itself becomes
// unwieldy; project policy is 3MB per file. Anything larger uploads to
// OneDrive and the share URL is appended to the body.

interface GraphFileAttachment {
  '@odata.type': '#microsoft.graph.fileAttachment';
  name: string;
  contentType: string;
  contentBytes: string;
}

function toGraphAttachments(items: readonly LocalAttachment[]): GraphFileAttachment[] {
  return items.map(att => ({
    '@odata.type': '#microsoft.graph.fileAttachment',
    name: att.name,
    contentType: att.mimeType,
    contentBytes: att.content.toString('base64'),
  }));
}

function loadUserAttachmentsForOutlook(
  paths: readonly string[] | undefined,
): { ok: true; attachments: LocalAttachment[] } | { ok: false; error: string } {
  if (!paths || paths.length === 0) return { ok: true, attachments: [] };
  return readLocalAttachments(paths);
}

async function getOrCreateOneDriveFolder(
  name: string,
  parentId: string | 'root',
  token: string,
): Promise<{ ok: true; id: string } | { ok: false; error: string }> {
  // Use $filter to find an existing folder with this name. Children endpoint
  // returns up to 200 items per page; for our well-defined attachments tree
  // a single page is always enough.
  const parentEndpoint = parentId === 'root'
    ? 'me/drive/root/children'
    : `me/drive/items/${encodeURIComponent(parentId)}/children`;
  const filter = `?$filter=${encodeURIComponent(`name eq '${name.replace(/'/g, "''")}'`)}&$select=id,name,folder`;
  try {
    const lookup = await fetch(`https://graph.microsoft.com/v1.0/${parentEndpoint}${filter}`, {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(15_000),
    });
    if (lookup.ok) {
      const data = await lookup.json() as { value?: Array<{ id?: string; name?: string; folder?: object }> };
      const existing = (data.value ?? []).find(item => item.folder && item.name === name && item.id);
      if (existing?.id) return { ok: true, id: existing.id };
    }
  } catch (err) {
    // Fall through to create attempt — lookup is best-effort.
    void err;
  }

  try {
    const createResp = await fetch(`https://graph.microsoft.com/v1.0/${parentEndpoint}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name,
        folder: {},
        '@microsoft.graph.conflictBehavior': 'rename',
      }),
      signal: AbortSignal.timeout(15_000),
    });
    if (!createResp.ok) {
      const err = await createResp.text();
      return { ok: false, error: `folder create failed: ${err.slice(0, 200)}` };
    }
    const data = await createResp.json() as { id?: string };
    if (!data.id) return { ok: false, error: 'folder created but Graph returned no ID' };
    return { ok: true, id: data.id };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

async function uploadAttachmentToOneDrive(
  att: LocalAttachment,
  slot: AccountSlot,
): Promise<{ ok: true; url: string; name: string } | { ok: false; error: string }> {
  const token = (await import('./auth.js')).getAccessToken(slot);
  if (!token) return { ok: false, error: 'not authenticated with Microsoft' };

  const root = await getOrCreateOneDriveFolder(ATTACHMENTS_ROOT_FOLDER, 'root', token);
  if (!root.ok) return { ok: false, error: `couldn't prepare OneDrive folder: ${root.error}` };
  const monthFolder = await getOrCreateOneDriveFolder(currentMonthFolderName(), root.id, token);
  if (!monthFolder.ok) return { ok: false, error: `couldn't prepare OneDrive month folder: ${monthFolder.error}` };

  // Upload. Files we route here are >3MB; some may be ≤4MB (the simple-PUT
  // boundary) and some larger. Use the same branch logic as onedrive_upload.
  const itemPath = `me/drive/items/${encodeURIComponent(monthFolder.id)}:/${encodeURIComponent(att.name)}`;
  type DriveItem = { id?: string; name?: string; webUrl?: string };
  let uploadedItem: DriveItem | null = null;

  try {
    if (att.size <= 4 * 1024 * 1024) {
      const resp = await fetch(`https://graph.microsoft.com/v1.0/${itemPath}:/content`, {
        method: 'PUT',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': att.mimeType },
        body: att.content,
        signal: AbortSignal.timeout(60_000),
      });
      if (!resp.ok) {
        const err = await resp.text();
        return { ok: false, error: `upload failed: ${err.slice(0, 200)}` };
      }
      uploadedItem = await resp.json() as DriveItem;
    } else {
      const sessionResp = await fetch(`https://graph.microsoft.com/v1.0/${itemPath}:/createUploadSession`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ item: { '@microsoft.graph.conflictBehavior': 'replace', name: att.name } }),
        signal: AbortSignal.timeout(30_000),
      });
      if (!sessionResp.ok) {
        const err = await sessionResp.text();
        return { ok: false, error: `upload session error: ${err.slice(0, 200)}` };
      }
      const session = await sessionResp.json() as { uploadUrl?: string };
      if (!session.uploadUrl) return { ok: false, error: 'OneDrive returned no upload URL' };

      const CHUNK_SIZE = 4 * 1024 * 1024;
      let offset = 0;
      while (offset < att.size) {
        const chunkSize = Math.min(CHUNK_SIZE, att.size - offset);
        const chunk = att.content.subarray(offset, offset + chunkSize);
        const chunkResp = await fetch(session.uploadUrl, {
          method: 'PUT',
          headers: {
            'Content-Length': String(chunkSize),
            'Content-Range': `bytes ${offset}-${offset + chunkSize - 1}/${att.size}`,
          },
          body: chunk,
          signal: AbortSignal.timeout(120_000),
        });
        if (!chunkResp.ok && chunkResp.status !== 202) {
          const err = await chunkResp.text();
          return { ok: false, error: `chunk upload failed at offset ${offset}: ${err.slice(0, 200)}` };
        }
        if (chunkResp.status === 201 || chunkResp.status === 200) {
          uploadedItem = await chunkResp.json() as DriveItem;
        }
        offset += chunkSize;
      }
    }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }

  if (!uploadedItem?.id) return { ok: false, error: 'upload completed but Graph returned no item ID' };

  // Create an anonymous view link.
  try {
    const linkResp = await fetch(`https://graph.microsoft.com/v1.0/me/drive/items/${encodeURIComponent(uploadedItem.id)}/createLink`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'view', scope: 'anonymous' }),
      signal: AbortSignal.timeout(15_000),
    });
    if (!linkResp.ok) {
      const err = await linkResp.text();
      return { ok: false, error: `uploaded but share-link creation failed: ${err.slice(0, 200)}` };
    }
    const linkData = await linkResp.json() as { link?: { webUrl?: string } };
    const url = linkData.link?.webUrl ?? uploadedItem.webUrl;
    if (!url) return { ok: false, error: 'uploaded and shared but no URL returned' };
    return { ok: true, url, name: uploadedItem.name ?? att.name };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * Walk user-provided attachments, partition into inline (≤3MB) vs. overflow
 * (>3MB), upload overflow to OneDrive, and return both the Graph-shaped
 * inline-attachment array AND the body-appended link block. Fail-fast: any
 * upload error aborts the whole send.
 */
async function prepareOutlookAttachments(
  paths: readonly string[] | undefined,
  slot: AccountSlot,
): Promise<{
  ok: true;
  inline: GraphFileAttachment[];
  inlineCount: number;
  overflowCount: number;
  bodySuffix: string;
} | { ok: false; error: string }> {
  const loaded = loadUserAttachmentsForOutlook(paths);
  if (!loaded.ok) return loaded;

  const { inline, overflow } = partitionForOutlook(loaded.attachments);
  const overflowLines: string[] = [];
  for (const att of overflow) {
    const up = await uploadAttachmentToOneDrive(att, slot);
    if (!up.ok) return { ok: false, error: `Error uploading attachment "${att.name}" to OneDrive: ${up.error}` };
    overflowLines.push(`  • ${up.name} (${formatSize(att.size)}) — ${up.url}`);
  }

  const bodySuffix = overflowLines.length > 0
    ? `\n\nAttached via OneDrive (file too large to inline):\n${overflowLines.join('\n')}`
    : '';

  return {
    ok: true,
    inline: toGraphAttachments(inline),
    inlineCount: inline.length,
    overflowCount: overflow.length,
    bodySuffix,
  };
}

// ── Tool Execution ──

const microsoftWriteToolDefByName = new Map(microsoftWriteToolDefinitions.map(t => [t.name, t]));

export async function executeMicrosoftWriteTool(
  name: string,
  args: Record<string, unknown>,
  agentId: string,
  agentName: string,
): Promise<string> {
  // v2.7.1 — same pattern as google/tools-write.ts. Only outlook_send/reply/
  // forward have user_ variants today; other Microsoft writes still target
  // the agent slot exclusively.
  let slot: import('./auth.js').AccountSlot = 'agent';
  let canonicalName = name;
  if (name.startsWith('user_')) {
    slot = 'user';
    canonicalName = name.slice('user_'.length);
  }

  const { validateAgainstSchema } = await import('../agent/tool-helpers.js');
  const def = microsoftWriteToolDefByName.get(canonicalName);
  const schemaErr = validateAgainstSchema(canonicalName, def?.input_schema as Parameters<typeof validateAgainstSchema>[1], args);
  if (schemaErr) return schemaErr;

  // Send-permission gate. Default off → must opt in per slot.
  if (canonicalName === 'outlook_send' || canonicalName === 'outlook_reply' || canonicalName === 'outlook_forward') {
    const { isMsEmailSendingEnabled } = await import('./auth.js');
    if (!isMsEmailSendingEnabled(slot)) {
      const slotLabel = slot === 'user' ? "user's Microsoft account" : "agent's Microsoft account";
      return `Error: sending email from the ${slotLabel} is disabled. Open Settings → Microsoft and turn on "Allow sending email" for the ${slot === 'user' ? 'User' : 'Agent'} slot, then try again.`;
    }
  }

  switch (canonicalName) {
    case 'outlook_send': {
      const toRecipients = parseRecipients(args.to as string);

      const prepared = await prepareOutlookAttachments(args.attachments as string[] | undefined, slot);
      if (!prepared.ok) return prepared.error;

      const bodyText = (args.body as string) + prepared.bodySuffix;
      const message: Record<string, unknown> = {
        subject: args.subject,
        body: { contentType: 'Text', content: bodyText },
        toRecipients,
      };
      if (args.cc) message.ccRecipients = parseRecipients(args.cc as string);
      if (prepared.inline.length > 0) message.attachments = prepared.inline;

      // Set display name from primary agent
      const displayName = getPrimaryAgentName();
      if (displayName) {
        // Graph API doesn't let you override the From display name on send,
        // but we can set it in the message object for clients that honor it
        message.from = { emailAddress: { name: displayName, address: '' } };
      }

      const result = await msGraphWrite('POST', 'me/sendMail', { message }, agentId, agentName, 'outlook_send', {
        to: args.to, subject: args.subject, slot, inlineAttachments: prepared.inlineCount, onedriveAttachments: prepared.overflowCount,
      }, slot);
      if (!result.ok) return `Error sending email: ${result.error}`;

      const attachSummary = (prepared.inlineCount + prepared.overflowCount) === 0 ? '' :
        ` with ${prepared.inlineCount} inline attachment(s)${prepared.overflowCount > 0 ? ` and ${prepared.overflowCount} OneDrive link(s)` : ''}`;
      return `Email sent to ${args.to} with subject "${args.subject}"${attachSummary}`;
    }

    case 'outlook_reply': {
      const messageId = encodeURIComponent(args.message_id as string);
      const replyAll = args.reply_all === true;
      const endpoint = `me/messages/${messageId}/${replyAll ? 'replyAll' : 'reply'}`;

      const prepared = await prepareOutlookAttachments(args.attachments as string[] | undefined, slot);
      if (!prepared.ok) return prepared.error;

      const bodyText = (args.body as string) + prepared.bodySuffix;

      // Graph's reply endpoint accepts either { comment } (plain quote) or
      // { message: { ... }, comment } when you need to attach files / set
      // body content explicitly. Use the richer form when attachments
      // are present so the inline files come through.
      const requestBody: Record<string, unknown> = prepared.inline.length > 0
        ? {
            message: {
              body: { contentType: 'Text', content: bodyText },
              attachments: prepared.inline,
            },
          }
        : { comment: bodyText };

      const result = await msGraphWrite('POST', endpoint, requestBody, agentId, agentName, 'outlook_reply', {
        messageId: args.message_id, replyAll, slot, inlineAttachments: prepared.inlineCount, onedriveAttachments: prepared.overflowCount,
      }, slot);
      if (!result.ok) return `Error replying to email: ${result.error}`;

      const attachSummary = (prepared.inlineCount + prepared.overflowCount) === 0 ? '' :
        ` with ${prepared.inlineCount} inline attachment(s)${prepared.overflowCount > 0 ? ` and ${prepared.overflowCount} OneDrive link(s)` : ''}`;
      return `Reply sent${replyAll ? ' (to all)' : ''} to message ${args.message_id}${attachSummary}`;
    }

    case 'outlook_forward': {
      const messageId = encodeURIComponent(args.message_id as string);
      const toRecipients = parseRecipients(args.to as string);

      const prepared = await prepareOutlookAttachments(args.attachments as string[] | undefined, slot);
      if (!prepared.ok) return prepared.error;

      const additionalText = ((args.body as string) ?? '') + prepared.bodySuffix;

      // Graph's /forward preserves the original message's attachments server-
      // side. To add NEW attachments OR custom body text we have to use the
      // richer `message` payload (with `comment` reduced to a no-op or
      // omitted). Note: when `message` is provided, the recipient also
      // gets the original message body Graph stitches in automatically.
      const requestBody: Record<string, unknown> = { toRecipients };
      if (prepared.inline.length > 0) {
        requestBody.message = {
          toRecipients,
          body: { contentType: 'Text', content: additionalText },
          attachments: prepared.inline,
        };
      } else if (additionalText.trim().length > 0) {
        requestBody.comment = additionalText;
      }

      const result = await msGraphWrite('POST', `me/messages/${messageId}/forward`, requestBody, agentId, agentName, 'outlook_forward', {
        messageId: args.message_id, to: args.to, slot, inlineAttachments: prepared.inlineCount, onedriveAttachments: prepared.overflowCount,
      }, slot);
      if (!result.ok) return `Error forwarding email: ${result.error}`;

      const attachSummary = (prepared.inlineCount + prepared.overflowCount) === 0 ? '' :
        ` with ${prepared.inlineCount} new inline attachment(s)${prepared.overflowCount > 0 ? ` and ${prepared.overflowCount} OneDrive link(s)` : ''} (original attachments preserved automatically)`;
      return `Email forwarded to ${args.to}${attachSummary}`;
    }

    case 'calendar_create_ms': {
      const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
      const calendarId = args.calendar_id as string | undefined;
      const event: Record<string, unknown> = {
        subject: args.title,
        start: { dateTime: args.start, timeZone: tz },
        end: { dateTime: args.end, timeZone: tz },
      };
      if (args.description) event.body = { contentType: 'Text', content: args.description };
      if (args.location) event.location = { displayName: args.location };
      if (args.attendees) {
        event.attendees = (args.attendees as string[]).map(email => ({
          emailAddress: { address: email },
          type: 'required',
        }));
      }

      const endpoint = `${calendarPrefix(calendarId)}events`;
      const result = await msGraphWrite('POST', endpoint, event, agentId, agentName, 'calendar_create_ms', {
        title: args.title, start: args.start, end: args.end, calendarId,
      });
      if (!result.ok) return `Error creating event: ${result.error}`;

      const data = result.data as { id?: string; webLink?: string };
      return `Calendar event "${args.title}" created${data?.id ? ` (ID: ${data.id})` : ''}${data?.webLink ? `\nLink: ${data.webLink}` : ''}`;
    }

    case 'calendar_update_ms': {
      const eventId = encodeURIComponent(args.event_id as string);
      const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
      const calendarId = args.calendar_id as string | undefined;
      const patch: Record<string, unknown> = {};
      if (args.title) patch.subject = args.title;
      if (args.start) patch.start = { dateTime: args.start, timeZone: tz };
      if (args.end) patch.end = { dateTime: args.end, timeZone: tz };
      if (args.description) patch.body = { contentType: 'Text', content: args.description };

      const endpoint = calendarId ? `${calendarPrefix(calendarId)}events/${eventId}` : `me/events/${eventId}`;
      const result = await msGraphWrite('PATCH', endpoint, patch, agentId, agentName, 'calendar_update_ms', {
        eventId: args.event_id, calendarId,
      });
      if (!result.ok) return `Error updating event: ${result.error}`;
      return `Calendar event ${args.event_id} updated`;
    }

    case 'calendar_delete_ms': {
      const eventId = encodeURIComponent(args.event_id as string);
      const calendarId = args.calendar_id as string | undefined;
      const endpoint = calendarId ? `${calendarPrefix(calendarId)}events/${eventId}` : `me/events/${eventId}`;
      const result = await msGraphWrite('DELETE', endpoint, undefined, agentId, agentName, 'calendar_delete_ms', {
        eventId: args.event_id, calendarId,
      });
      if (!result.ok) return `Error deleting event: ${result.error}`;
      return `Calendar event ${args.event_id} deleted`;
    }

    case 'onedrive_create_folder': {
      const folderName = args.name as string;
      const parentFolderId = args.parent_folder_id as string | undefined;
      const driveId = args.drive_id as string | undefined;
      const prefix = drivePrefix(driveId);

      const endpoint = parentFolderId
        ? `${prefix}items/${encodeURIComponent(parentFolderId)}/children`
        : `${prefix}root/children`;

      const result = await msGraphWrite('POST', endpoint, {
        name: folderName,
        folder: {},
        '@microsoft.graph.conflictBehavior': 'rename',
      }, agentId, agentName, 'onedrive_create_folder', { folderName, parentFolderId, driveId });

      if (!result.ok) return `Error creating folder: ${result.error}`;
      const folder = result.data as { id?: string; name?: string; webUrl?: string };
      return `Folder "${folder.name ?? folderName}" created in OneDrive${folder.id ? ` (ID: ${folder.id})` : ''}${folder.webUrl ? `\nLink: ${folder.webUrl}` : ''}`;
    }

    case 'onedrive_upload': {
      const filePath = args.file_path as string;
      const fileName = (args.name as string) ?? filePath.split('/').pop() ?? 'upload';
      const folderId = args.folder_id as string | undefined;
      const driveId = args.drive_id as string | undefined;
      const prefix = drivePrefix(driveId);

      const fs = await import('node:fs');
      if (!fs.existsSync(filePath)) return `Error: File not found at ${filePath}`;

      const stat = fs.statSync(filePath);
      const fileSize = stat.size;
      const token = (await import('./auth.js')).getAccessToken();
      if (!token) return 'Error: Not authenticated with Microsoft';

      const itemPath = folderId
        ? `${prefix}items/${encodeURIComponent(folderId)}:/${encodeURIComponent(fileName)}`
        : `${prefix}root:/${encodeURIComponent(fileName)}`;

      try {
        // Small files (≤4MB): simple PUT upload
        if (fileSize <= 4 * 1024 * 1024) {
          const content = fs.readFileSync(filePath);
          const resp = await fetch(`https://graph.microsoft.com/v1.0/${itemPath}:/content`, {
            method: 'PUT',
            headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/octet-stream' },
            body: content,
            signal: AbortSignal.timeout(60_000),
          });
          if (!resp.ok) {
            const err = await resp.text();
            return `Error uploading to OneDrive: ${err.slice(0, 200)}`;
          }
          const data = await resp.json() as { id?: string; name?: string; webUrl?: string };
          return `File uploaded to OneDrive: ${data.name ?? fileName}${data.id ? ` (ID: ${data.id})` : ''}${data.webUrl ? `\nLink: ${data.webUrl}` : ''}`;
        }

        // Large files: resumable upload session
        const sessionResp = await fetch(`https://graph.microsoft.com/v1.0/${itemPath}:/createUploadSession`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ item: { '@microsoft.graph.conflictBehavior': 'replace', name: fileName } }),
          signal: AbortSignal.timeout(30_000),
        });
        if (!sessionResp.ok) {
          const err = await sessionResp.text();
          return `Error creating upload session: ${err.slice(0, 200)}`;
        }
        const session = await sessionResp.json() as { uploadUrl?: string };
        if (!session.uploadUrl) return 'Error: no upload URL returned from OneDrive';

        // Upload in 4MB chunks
        const CHUNK_SIZE = 4 * 1024 * 1024;
        const fd = fs.openSync(filePath, 'r');
        let offset = 0;
        let finalData: { id?: string; name?: string; webUrl?: string } | null = null;

        try {
          while (offset < fileSize) {
            const chunkSize = Math.min(CHUNK_SIZE, fileSize - offset);
            const chunk = Buffer.alloc(chunkSize);
            fs.readSync(fd, chunk, 0, chunkSize, offset);

            const chunkResp = await fetch(session.uploadUrl, {
              method: 'PUT',
              headers: {
                'Content-Length': String(chunkSize),
                'Content-Range': `bytes ${offset}-${offset + chunkSize - 1}/${fileSize}`,
              },
              body: chunk,
              signal: AbortSignal.timeout(120_000),
            });

            if (!chunkResp.ok && chunkResp.status !== 202) {
              const err = await chunkResp.text();
              return `Error uploading chunk at offset ${offset}: ${err.slice(0, 200)}`;
            }

            if (chunkResp.status === 201 || chunkResp.status === 200) {
              finalData = await chunkResp.json() as { id?: string; name?: string; webUrl?: string };
            }

            offset += chunkSize;
          }
        } finally {
          fs.closeSync(fd);
        }

        const sizeMB = Math.round(fileSize / 1024 / 1024 * 10) / 10;
        return `File uploaded to OneDrive: ${finalData?.name ?? fileName} (${sizeMB}MB)${finalData?.id ? ` (ID: ${finalData.id})` : ''}${finalData?.webUrl ? `\nLink: ${finalData.webUrl}` : ''}`;
      } catch (err) {
        return `Error uploading to OneDrive: ${err instanceof Error ? err.message : String(err)}`;
      }
    }

    case 'teams_create_chat': {
      const memberEmails = args.members as string[];
      if (!memberEmails || memberEmails.length === 0) {
        return 'Error: at least one member email is required';
      }

      const chatType = memberEmails.length === 1 ? 'oneOnOne' : 'group';

      // Pass UPNs (emails) directly in the bind URL — no directory lookup needed.
      // The signed-in user is included automatically by Graph when using /chats,
      // but we add them explicitly as owner to satisfy the API requirement.
      const meResult = await msGraphRead('me?$select=id', agentId, agentName, 'teams_create_chat_me', {});
      if (!meResult.ok) return `Error fetching signed-in user: ${meResult.error}`;
      const me = meResult.data as { id?: string };
      if (!me?.id) return 'Error: could not determine signed-in user ID';

      const members: Record<string, unknown>[] = [
        {
          '@odata.type': '#microsoft.graph.aadUserConversationMember',
          'user@odata.bind': `https://graph.microsoft.com/v1.0/users('${me.id}')`,
          roles: ['owner'],
        },
        ...memberEmails.map(email => ({
          '@odata.type': '#microsoft.graph.aadUserConversationMember',
          'user@odata.bind': `https://graph.microsoft.com/v1.0/users('${email}')`,
          roles: ['owner'],
        })),
      ];

      const chatBody: Record<string, unknown> = { chatType, members };
      if (chatType === 'group' && args.topic) chatBody.topic = args.topic as string;

      const result = await msGraphWrite('POST', 'chats', chatBody, agentId, agentName, 'teams_create_chat', {
        chatType, members: memberEmails,
      });

      if (!result.ok) return `Error creating Teams chat: ${result.error}`;
      const chat = result.data as { id?: string };
      if (!chat?.id) return 'Error: chat created but no ID returned';

      const memberList = memberEmails.join(', ');
      return `Teams ${chatType} chat created with ${memberList}\nChat ID: ${chat.id}\n\nYou can now use teams_send_message with this chat_id to send a message.`;
    }

    case 'teams_send_message': {
      const chatId = encodeURIComponent(args.chat_id as string);
      const message = args.message as string;

      const result = await msGraphWrite('POST', `chats/${chatId}/messages`, {
        body: { content: message },
      }, agentId, agentName, 'teams_send_message', { chatId: args.chat_id });

      if (!result.ok) return `Error sending Teams message: ${result.error}`;
      return `Teams message sent to chat ${args.chat_id}`;
    }

    case 'onedrive_share': {
      const fileId = encodeURIComponent(args.file_id as string);
      const email = args.email as string | undefined;
      const role = (args.role as string) ?? 'read';
      const shareType = (args.type as string) ?? 'link';
      const driveId = args.drive_id as string | undefined;
      const prefix = drivePrefix(driveId);

      if (shareType === 'invite' && email) {
        // Direct invite
        const result = await msGraphWrite('POST', `${prefix}items/${fileId}/invite`, {
          recipients: [{ email }],
          roles: [role === 'write' ? 'write' : 'read'],
          requireSignIn: true,
          sendInvitation: true,
        }, agentId, agentName, 'onedrive_share', { fileId: args.file_id, email, role, driveId });

        if (!result.ok) return `Error sharing file: ${result.error}`;
        return `File shared with ${email} (${role} access). They'll receive an email invitation.`;
      } else {
        // Create sharing link
        const linkType = role === 'write' ? 'edit' : 'view';
        const scope = email ? 'users' : 'anonymous';

        const result = await msGraphWrite('POST', `${prefix}items/${fileId}/createLink`, {
          type: linkType,
          scope,
        }, agentId, agentName, 'onedrive_share', { fileId: args.file_id, role, scope, driveId });

        if (!result.ok) return `Error creating sharing link: ${result.error}`;
        const data = result.data as { link?: { webUrl?: string } };
        return `Sharing link created: ${data?.link?.webUrl ?? '(no URL returned)'}`;
      }
    }

    case 'outlook_mark_read': {
      const messageId = encodeURIComponent(args.message_id as string);
      const isRead = args.is_read !== false; // default: true (mark as read)

      const result = await msGraphWrite('PATCH', `me/messages/${messageId}`, { isRead }, agentId, agentName, 'outlook_mark_read', {
        messageId: args.message_id, isRead,
      });
      if (!result.ok) return `Error marking email: ${result.error}`;
      return `Email marked as ${isRead ? 'read' : 'unread'}`;
    }

    case 'outlook_delete': {
      const messageId = encodeURIComponent(args.message_id as string);

      const result = await msGraphWrite('DELETE', `me/messages/${messageId}`, undefined, agentId, agentName, 'outlook_delete', {
        messageId: args.message_id,
      });
      if (!result.ok) return `Error deleting email: ${result.error}`;
      return `Email moved to Deleted Items`;
    }

    case 'outlook_download_attachment': {
      const messageId = encodeURIComponent(args.message_id as string);
      const attachmentId = encodeURIComponent(args.attachment_id as string);

      const result = await msGraphRead(
        `me/messages/${messageId}/attachments/${attachmentId}`,
        agentId, agentName, 'outlook_download_attachment', { messageId: args.message_id, attachmentId: args.attachment_id },
      );
      if (!result.ok) return `Error fetching attachment: ${result.error}`;

      const att = result.data as { name?: string; contentType?: string; contentBytes?: string; size?: number };
      if (!att?.contentBytes) return 'Error: attachment has no downloadable content (may be an inline image or reference attachment)';

      const fs = await import('node:fs');
      const os = await import('node:os');
      const nodePath = await import('node:path');

      const fileName = att.name ?? 'attachment';
      const outPath = (args.save_path as string | undefined) ?? nodePath.join(os.homedir(), 'Downloads', fileName);
      const content = Buffer.from(att.contentBytes, 'base64');
      fs.writeFileSync(outPath, content);

      return `Attachment "${fileName}" saved to ${outPath} (${Math.round(content.length / 1024)}KB)`;
    }

    case 'calendar_respond_invite_ms': {
      const eventId = encodeURIComponent(args.event_id as string);
      const response = args.response as string;

      const endpointMap: Record<string, string> = {
        accept: 'accept',
        decline: 'decline',
        tentative: 'tentativelyAccept',
      };
      const action = endpointMap[response];
      if (!action) return 'Error: response must be "accept", "decline", or "tentative"';

      const result = await msGraphWrite('POST', `me/events/${eventId}/${action}`, {
        comment: (args.comment as string) ?? '',
        sendResponse: true,
      }, agentId, agentName, 'calendar_respond_invite_ms', { eventId: args.event_id, response });

      if (!result.ok) return `Error responding to invite: ${result.error}`;
      return `Meeting invite ${response}ed${args.comment ? ` with comment: "${args.comment}"` : ''}`;
    }

    case 'calendar_accept_share_ms': {
      const rawMessageId = args.message_id as string;
      const messageId = encodeURIComponent(rawMessageId);

      // Step 1: read the share-invitation message to extract the owner's
      // email. Microsoft Graph doesn't expose a reliable "accept share"
      // endpoint, but the share itself was already granted server-side
      // when the owner sent it. With Calendars.ReadWrite.Shared scope we
      // can directly access the owner's calendar via /users/{email}/...
      // — no UI acceptance required. So "accepting" reduces to verifying
      // delegate access works and handing the agent the owner's email
      // to use as calendar_id on subsequent calls.
      const msg = await msGraphRead(
        `me/messages/${messageId}?$select=from,subject,itemClass`,
        agentId, agentName, 'calendar_accept_share_ms:read', { messageId: rawMessageId },
      );
      if (!msg.ok) return `Error reading share-invitation message: ${msg.error}`;

      const m = msg.data as { from?: { emailAddress?: { address?: string; name?: string } }; subject?: string; itemClass?: string };
      const ownerEmail = m.from?.emailAddress?.address;
      const ownerName = m.from?.emailAddress?.name;
      if (!ownerEmail) {
        return `Error: could not determine the calendar owner's email from message ${rawMessageId}. Subject: "${m.subject ?? '(none)'}". The message may not be a calendar share invitation.`;
      }

      // Step 2: verify direct delegate access works.
      const verify = await msGraphRead(
        `users/${encodeURIComponent(ownerEmail)}/calendar?$select=id,name,owner`,
        agentId, agentName, 'calendar_accept_share_ms:verify', { ownerEmail },
      );
      if (!verify.ok) {
        const errStr = String(verify.error ?? '');
        if (/403|Forbidden|AccessDenied/i.test(errStr)) {
          return `Could not access ${ownerName ?? ownerEmail}'s calendar (HTTP 403). The share permission may not be active yet, may have been revoked, or the Calendars.ReadWrite.Shared scope was not granted at OAuth time. Ask ${ownerName ?? ownerEmail} to re-share, or reconnect Microsoft to refresh scopes.`;
        }
        return `Could not access ${ownerName ?? ownerEmail}'s calendar: ${errStr}`;
      }

      // Step 3: try the experimental Graph endpoint to add it to the
      // user's calendar list (so it shows up in calendar_list_ms too).
      // Best-effort — failure here doesn't affect direct access.
      const addResult = await msGraphWrite(
        'POST',
        `me/messages/${messageId}/microsoft.graph.calendarSharingMessage/accept`,
        {},
        agentId, agentName, 'calendar_accept_share_ms:add', { messageId: rawMessageId },
      );
      const addedToList = addResult.ok;

      const cal = verify.data as { id?: string; name?: string };
      return `Calendar share accepted for ${ownerName ?? ownerEmail}. ` +
        `Calendar name: "${cal.name ?? 'Calendar'}". ` +
        `Use calendar_id="${ownerEmail}" with calendar_agenda_ms / calendar_create_ms / etc. to operate on it. ` +
        (addedToList
          ? 'Also added to your personal calendar list — calendar_list_ms will show it.'
          : 'Note: could not add to your personal calendar list (Microsoft Graph limitation). Direct access via the email above still works.');
    }

    case 'onedrive_delete': {
      const fileId = encodeURIComponent(args.file_id as string);
      const driveId = args.drive_id as string | undefined;
      const prefix = drivePrefix(driveId);

      const result = await msGraphWrite('DELETE', `${prefix}items/${fileId}`, undefined, agentId, agentName, 'onedrive_delete', {
        fileId: args.file_id, driveId,
      });
      if (!result.ok) return `Error deleting from OneDrive: ${result.error}`;
      return `Item deleted from OneDrive`;
    }

    case 'onedrive_move': {
      const fileId = encodeURIComponent(args.file_id as string);
      const driveId = args.drive_id as string | undefined;
      const prefix = drivePrefix(driveId);
      const patch: Record<string, unknown> = {};
      if (args.new_name) patch.name = args.new_name as string;
      if (args.new_parent_id) patch.parentReference = { id: args.new_parent_id as string };

      if (Object.keys(patch).length === 0) return 'Error: provide new_name and/or new_parent_id';

      const result = await msGraphWrite('PATCH', `${prefix}items/${fileId}`, patch, agentId, agentName, 'onedrive_move', {
        fileId: args.file_id, newName: args.new_name, newParentId: args.new_parent_id, driveId,
      });
      if (!result.ok) return `Error moving/renaming OneDrive item: ${result.error}`;
      const data = result.data as { name?: string };
      return `OneDrive item updated${data?.name ? `: now named "${data.name}"` : ''}`;
    }

    case 'onedrive_upload_batch': {
      const filePaths = args.file_paths as string[];
      const folderId = args.folder_id as string | undefined;
      const driveId = args.drive_id as string | undefined;
      const prefix = drivePrefix(driveId);

      if (!filePaths || filePaths.length === 0) return 'Error: file_paths must be a non-empty array';

      const fs = await import('node:fs');
      const token = (await import('./auth.js')).getAccessToken();
      if (!token) return 'Error: Not authenticated with Microsoft';

      type UploadResult = { path: string; ok: boolean; message: string };

      async function uploadOne(filePath: string): Promise<UploadResult> {
        if (!fs.existsSync(filePath)) return { path: filePath, ok: false, message: 'File not found' };

        const fileName = filePath.split('/').pop() ?? 'upload';
        const stat = fs.statSync(filePath);
        const fileSize = stat.size;

        const itemPath = folderId
          ? `${prefix}items/${encodeURIComponent(folderId)}:/${encodeURIComponent(fileName)}`
          : `${prefix}root:/${encodeURIComponent(fileName)}`;

        try {
          if (fileSize <= 4 * 1024 * 1024) {
            // Small file: simple PUT
            const content = fs.readFileSync(filePath);
            const resp = await fetch(`https://graph.microsoft.com/v1.0/${itemPath}:/content`, {
              method: 'PUT',
              headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/octet-stream' },
              body: content,
              signal: AbortSignal.timeout(60_000),
            });
            if (!resp.ok) {
              const err = await resp.text();
              return { path: filePath, ok: false, message: err.slice(0, 150) };
            }
            return { path: filePath, ok: true, message: fileName };
          }

          // Large file: resumable upload session
          const sessionResp = await fetch(`https://graph.microsoft.com/v1.0/${itemPath}:/createUploadSession`, {
            method: 'POST',
            headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({ item: { '@microsoft.graph.conflictBehavior': 'replace', name: fileName } }),
            signal: AbortSignal.timeout(30_000),
          });
          if (!sessionResp.ok) {
            return { path: filePath, ok: false, message: `Session error: ${(await sessionResp.text()).slice(0, 100)}` };
          }
          const session = await sessionResp.json() as { uploadUrl?: string };
          if (!session.uploadUrl) return { path: filePath, ok: false, message: 'No upload URL returned' };

          const CHUNK_SIZE = 4 * 1024 * 1024;
          const fd = fs.openSync(filePath, 'r');
          let offset = 0;
          try {
            while (offset < fileSize) {
              const chunkSize = Math.min(CHUNK_SIZE, fileSize - offset);
              const chunk = Buffer.alloc(chunkSize);
              fs.readSync(fd, chunk, 0, chunkSize, offset);
              const chunkResp = await fetch(session.uploadUrl, {
                method: 'PUT',
                headers: {
                  'Content-Length': String(chunkSize),
                  'Content-Range': `bytes ${offset}-${offset + chunkSize - 1}/${fileSize}`,
                },
                body: chunk,
                signal: AbortSignal.timeout(120_000),
              });
              if (!chunkResp.ok && chunkResp.status !== 202) {
                return { path: filePath, ok: false, message: `Chunk error at ${offset}: ${(await chunkResp.text()).slice(0, 100)}` };
              }
              offset += chunkSize;
            }
          } finally {
            fs.closeSync(fd);
          }
          return { path: filePath, ok: true, message: `${fileName} (${Math.round(fileSize / 1024 / 1024 * 10) / 10}MB)` };

        } catch (err) {
          return { path: filePath, ok: false, message: err instanceof Error ? err.message : String(err) };
        }
      }

      // Upload in batches of 5 to avoid overwhelming the Graph API
      const results: UploadResult[] = [];
      const BATCH = 5;
      for (let i = 0; i < filePaths.length; i += BATCH) {
        const chunk = filePaths.slice(i, i + BATCH);
        const settled = await Promise.allSettled(chunk.map(uploadOne));
        for (const s of settled) {
          if (s.status === 'fulfilled') results.push(s.value);
          else results.push({ path: '?', ok: false, message: String(s.reason) });
        }
      }

      const succeeded = results.filter(r => r.ok);
      const failed = results.filter(r => !r.ok);

      let summary = `Batch upload: ${succeeded.length}/${filePaths.length} files uploaded successfully.`;
      if (failed.length > 0) {
        summary += `\n\nFailed (${failed.length}):\n` + failed.map(f => `- ${f.path}: ${f.message}`).join('\n');
      }
      return summary;
    }

    case 'teams_send_channel_message': {
      const teamId = encodeURIComponent(args.team_id as string);
      const channelId = encodeURIComponent(args.channel_id as string);

      const result = await msGraphWrite('POST', `teams/${teamId}/channels/${channelId}/messages`, {
        body: { content: args.message as string },
      }, agentId, agentName, 'teams_send_channel_message', { teamId: args.team_id, channelId: args.channel_id });

      if (!result.ok) return `Error sending channel message: ${result.error}`;
      return `Message posted to channel`;
    }

    case 'online_meeting_create': {
      const subject = args.subject as string;
      const start = args.start as string;
      const end = args.end as string;
      const result = await msGraphWrite('POST', 'me/onlineMeetings', {
        subject,
        startDateTime: start,
        endDateTime: end,
      }, agentId, agentName, 'online_meeting_create', { subject, start, end });
      if (!result.ok) return `Error creating online meeting: ${result.error}`;
      const m = result.data as { id?: string; joinUrl?: string; joinWebUrl?: string };
      const lines = [
        `Online meeting "${subject}" created.`,
        m.id ? `ID: ${m.id}` : null,
        m.joinUrl ? `Join URL: ${m.joinUrl}` : null,
        m.joinWebUrl && m.joinWebUrl !== m.joinUrl ? `Web URL: ${m.joinWebUrl}` : null,
        '',
        'To attach this meeting to a calendar event, include the join URL in the description when calling calendar_create_ms.',
      ].filter(Boolean);
      return lines.join('\n');
    }

    case 'online_meeting_update': {
      const meetingId = encodeURIComponent(args.meeting_id as string);
      const patch: Record<string, unknown> = {};
      if (args.subject) patch.subject = args.subject as string;
      if (args.start) patch.startDateTime = args.start as string;
      if (args.end) patch.endDateTime = args.end as string;
      if (Object.keys(patch).length === 0) return 'Error: provide at least one of subject, start, end';
      const result = await msGraphWrite('PATCH', `me/onlineMeetings/${meetingId}`, patch, agentId, agentName, 'online_meeting_update', { meetingId: args.meeting_id, ...patch });
      if (!result.ok) return `Error updating online meeting: ${result.error}`;
      return `Online meeting ${args.meeting_id} updated. Join URL is unchanged.`;
    }

    case 'online_meeting_delete': {
      const meetingId = encodeURIComponent(args.meeting_id as string);
      const result = await msGraphWrite('DELETE', `me/onlineMeetings/${meetingId}`, undefined, agentId, agentName, 'online_meeting_delete', { meetingId: args.meeting_id });
      if (!result.ok) return `Error deleting online meeting: ${result.error}`;
      return `Online meeting ${args.meeting_id} deleted. The join URL is now invalid.`;
    }

    default:
      return `Unknown Microsoft write tool: ${name}`;
  }
}
