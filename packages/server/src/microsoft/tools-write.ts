// ════════════════════════════════════════
// Microsoft 365 WRITE Tools
// Available to: primary agent ONLY
// ════════════════════════════════════════

import type { ToolDefinition } from '../agent/tools.js';
import { msGraphRead, msGraphWrite } from './client.js';
import { getPrimaryAgentName } from '../config/platform.js';

// ── Tool Definitions ──

export const microsoftWriteToolDefinitions: ToolDefinition[] = [
  {
    name: 'outlook_send',
    description: 'Send an email from the connected Microsoft account (Outlook).',
    input_schema: {
      type: 'object',
      properties: {
        to: { type: 'string', description: 'Recipient email address (or comma-separated list)' },
        subject: { type: 'string', description: 'Email subject line' },
        body: { type: 'string', description: 'Email body text' },
        cc: { type: 'string', description: 'CC recipients (comma-separated)' },
      },
      required: ['to', 'subject', 'body'],
    },
  },
  {
    name: 'outlook_reply',
    description: 'Reply to an existing Outlook email thread.',
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
    name: 'outlook_forward',
    description: 'Forward an Outlook email to new recipients.',
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
    name: 'calendar_create_ms',
    description: 'Create a new Microsoft Calendar event.',
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
    name: 'calendar_update_ms',
    description: 'Update an existing Microsoft Calendar event.',
    input_schema: {
      type: 'object',
      properties: {
        event_id: { type: 'string', description: 'Calendar event ID' },
        title: { type: 'string', description: 'New event title' },
        start: { type: 'string', description: 'New start datetime' },
        end: { type: 'string', description: 'New end datetime' },
        description: { type: 'string', description: 'New description' },
      },
      required: ['event_id'],
    },
  },
  {
    name: 'calendar_delete_ms',
    description: 'Delete a Microsoft Calendar event.',
    input_schema: {
      type: 'object',
      properties: {
        event_id: { type: 'string', description: 'Calendar event ID to delete' },
      },
      required: ['event_id'],
    },
  },
  {
    name: 'onedrive_create_folder',
    description: 'Create a new folder in OneDrive.',
    input_schema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Folder name to create' },
        parent_folder_id: { type: 'string', description: 'ID of the parent folder to create inside (omit to create in root)' },
      },
      required: ['name'],
    },
  },
  {
    name: 'onedrive_upload',
    description: 'Upload a file to OneDrive. Handles files of any size using resumable upload sessions for large files.',
    input_schema: {
      type: 'object',
      properties: {
        file_path: { type: 'string', description: 'Local file path to upload' },
        name: { type: 'string', description: 'Name for the file in OneDrive (defaults to local filename)' },
        folder_id: { type: 'string', description: 'Upload to a specific OneDrive folder (omit for root)' },
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
    description: 'Share a OneDrive file or folder with someone via a sharing link or direct permission.',
    input_schema: {
      type: 'object',
      properties: {
        file_id: { type: 'string', description: 'OneDrive file or folder ID to share' },
        email: { type: 'string', description: 'Email address to share with (omit for anonymous link)' },
        role: { type: 'string', enum: ['read', 'write'], description: "Permission level (default: 'read')" },
        type: { type: 'string', enum: ['link', 'invite'], description: "Share method: 'link' for sharing link, 'invite' for direct email invite (default: 'link')" },
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
    name: 'calendar_respond_invite',
    description: 'Accept, decline, or tentatively accept a Microsoft Calendar meeting invite.',
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
    name: 'onedrive_delete',
    description: 'Delete a file or folder from OneDrive.',
    input_schema: {
      type: 'object',
      properties: {
        file_id: { type: 'string', description: 'OneDrive file or folder ID to delete' },
      },
      required: ['file_id'],
    },
  },
  {
    name: 'onedrive_move',
    description: 'Move or rename a file or folder in OneDrive. Provide new_name to rename, new_parent_id to move, or both.',
    input_schema: {
      type: 'object',
      properties: {
        file_id: { type: 'string', description: 'OneDrive file or folder ID' },
        new_name: { type: 'string', description: 'New name for the item (omit to keep current name)' },
        new_parent_id: { type: 'string', description: 'ID of the destination folder (omit to keep in current location)' },
      },
      required: ['file_id'],
    },
  },
  {
    name: 'onedrive_upload_batch',
    description: 'Upload multiple files to OneDrive in a single tool call. Handles files of any size. Returns a summary of successes and failures.',
    input_schema: {
      type: 'object',
      properties: {
        file_paths: {
          type: 'array',
          items: { type: 'string' },
          description: 'Array of local file paths to upload',
        },
        folder_id: { type: 'string', description: 'Upload to a specific OneDrive folder ID (omit for root)' },
      },
      required: ['file_paths'],
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

// ── Helpers ──

function parseRecipients(str: string): Array<{ emailAddress: { address: string } }> {
  return str.split(',').map(s => s.trim()).filter(Boolean).map(address => ({
    emailAddress: { address },
  }));
}

// ── Tool Execution ──

export async function executeMicrosoftWriteTool(
  name: string,
  args: Record<string, unknown>,
  agentId: string,
  agentName: string,
): Promise<string> {
  switch (name) {
    case 'outlook_send': {
      const toRecipients = parseRecipients(args.to as string);
      const message: Record<string, unknown> = {
        subject: args.subject,
        body: { contentType: 'Text', content: args.body },
        toRecipients,
      };
      if (args.cc) message.ccRecipients = parseRecipients(args.cc as string);

      // Set display name from primary agent
      const displayName = getPrimaryAgentName();
      if (displayName) {
        // Graph API doesn't let you override the From display name on send,
        // but we can set it in the message object for clients that honor it
        message.from = { emailAddress: { name: displayName, address: '' } };
      }

      const result = await msGraphWrite('POST', 'me/sendMail', { message }, agentId, agentName, 'outlook_send', {
        to: args.to, subject: args.subject,
      });
      if (!result.ok) return `Error sending email: ${result.error}`;
      return `Email sent to ${args.to} with subject "${args.subject}"`;
    }

    case 'outlook_reply': {
      const messageId = encodeURIComponent(args.message_id as string);
      const replyAll = args.reply_all === true;
      const endpoint = `me/messages/${messageId}/${replyAll ? 'replyAll' : 'reply'}`;

      const result = await msGraphWrite('POST', endpoint, { comment: args.body }, agentId, agentName, 'outlook_reply', {
        messageId: args.message_id, replyAll,
      });
      if (!result.ok) return `Error replying to email: ${result.error}`;
      return `Reply sent${replyAll ? ' (to all)' : ''} to message ${args.message_id}`;
    }

    case 'outlook_forward': {
      const messageId = encodeURIComponent(args.message_id as string);
      const toRecipients = parseRecipients(args.to as string);

      const body: Record<string, unknown> = { toRecipients };
      if (args.body) body.comment = args.body;

      const result = await msGraphWrite('POST', `me/messages/${messageId}/forward`, body, agentId, agentName, 'outlook_forward', {
        messageId: args.message_id, to: args.to,
      });
      if (!result.ok) return `Error forwarding email: ${result.error}`;
      return `Email forwarded to ${args.to}`;
    }

    case 'calendar_create_ms': {
      const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
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

      const result = await msGraphWrite('POST', 'me/events', event, agentId, agentName, 'calendar_create_ms', {
        title: args.title, start: args.start, end: args.end,
      });
      if (!result.ok) return `Error creating event: ${result.error}`;

      const data = result.data as { id?: string; webLink?: string };
      return `Calendar event "${args.title}" created${data?.id ? ` (ID: ${data.id})` : ''}${data?.webLink ? `\nLink: ${data.webLink}` : ''}`;
    }

    case 'calendar_update_ms': {
      const eventId = encodeURIComponent(args.event_id as string);
      const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
      const patch: Record<string, unknown> = {};
      if (args.title) patch.subject = args.title;
      if (args.start) patch.start = { dateTime: args.start, timeZone: tz };
      if (args.end) patch.end = { dateTime: args.end, timeZone: tz };
      if (args.description) patch.body = { contentType: 'Text', content: args.description };

      const result = await msGraphWrite('PATCH', `me/events/${eventId}`, patch, agentId, agentName, 'calendar_update_ms', {
        eventId: args.event_id,
      });
      if (!result.ok) return `Error updating event: ${result.error}`;
      return `Calendar event ${args.event_id} updated`;
    }

    case 'calendar_delete_ms': {
      const eventId = encodeURIComponent(args.event_id as string);
      const result = await msGraphWrite('DELETE', `me/events/${eventId}`, undefined, agentId, agentName, 'calendar_delete_ms', {
        eventId: args.event_id,
      });
      if (!result.ok) return `Error deleting event: ${result.error}`;
      return `Calendar event ${args.event_id} deleted`;
    }

    case 'onedrive_create_folder': {
      const folderName = args.name as string;
      const parentFolderId = args.parent_folder_id as string | undefined;

      const endpoint = parentFolderId
        ? `me/drive/items/${encodeURIComponent(parentFolderId)}/children`
        : 'me/drive/root/children';

      const result = await msGraphWrite('POST', endpoint, {
        name: folderName,
        folder: {},
        '@microsoft.graph.conflictBehavior': 'rename',
      }, agentId, agentName, 'onedrive_create_folder', { folderName, parentFolderId });

      if (!result.ok) return `Error creating folder: ${result.error}`;
      const folder = result.data as { id?: string; name?: string; webUrl?: string };
      return `Folder "${folder.name ?? folderName}" created in OneDrive${folder.id ? ` (ID: ${folder.id})` : ''}${folder.webUrl ? `\nLink: ${folder.webUrl}` : ''}`;
    }

    case 'onedrive_upload': {
      const filePath = args.file_path as string;
      const fileName = (args.name as string) ?? filePath.split('/').pop() ?? 'upload';
      const folderId = args.folder_id as string | undefined;

      const fs = await import('node:fs');
      if (!fs.existsSync(filePath)) return `Error: File not found at ${filePath}`;

      const stat = fs.statSync(filePath);
      const fileSize = stat.size;
      const token = (await import('./auth.js')).getAccessToken();
      if (!token) return 'Error: Not authenticated with Microsoft';

      const itemPath = folderId
        ? `me/drive/items/${encodeURIComponent(folderId)}:/${encodeURIComponent(fileName)}`
        : `me/drive/root:/${encodeURIComponent(fileName)}`;

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

      if (shareType === 'invite' && email) {
        // Direct invite
        const result = await msGraphWrite('POST', `me/drive/items/${fileId}/invite`, {
          recipients: [{ email }],
          roles: [role === 'write' ? 'write' : 'read'],
          requireSignIn: true,
          sendInvitation: true,
        }, agentId, agentName, 'onedrive_share', { fileId: args.file_id, email, role });

        if (!result.ok) return `Error sharing file: ${result.error}`;
        return `File shared with ${email} (${role} access). They'll receive an email invitation.`;
      } else {
        // Create sharing link
        const linkType = role === 'write' ? 'edit' : 'view';
        const scope = email ? 'users' : 'anonymous';

        const result = await msGraphWrite('POST', `me/drive/items/${fileId}/createLink`, {
          type: linkType,
          scope,
        }, agentId, agentName, 'onedrive_share', { fileId: args.file_id, role, scope });

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

    case 'calendar_respond_invite': {
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
      }, agentId, agentName, 'calendar_respond_invite', { eventId: args.event_id, response });

      if (!result.ok) return `Error responding to invite: ${result.error}`;
      return `Meeting invite ${response}ed${args.comment ? ` with comment: "${args.comment}"` : ''}`;
    }

    case 'onedrive_delete': {
      const fileId = encodeURIComponent(args.file_id as string);

      const result = await msGraphWrite('DELETE', `me/drive/items/${fileId}`, undefined, agentId, agentName, 'onedrive_delete', {
        fileId: args.file_id,
      });
      if (!result.ok) return `Error deleting from OneDrive: ${result.error}`;
      return `Item deleted from OneDrive`;
    }

    case 'onedrive_move': {
      const fileId = encodeURIComponent(args.file_id as string);
      const patch: Record<string, unknown> = {};
      if (args.new_name) patch.name = args.new_name as string;
      if (args.new_parent_id) patch.parentReference = { id: args.new_parent_id as string };

      if (Object.keys(patch).length === 0) return 'Error: provide new_name and/or new_parent_id';

      const result = await msGraphWrite('PATCH', `me/drive/items/${fileId}`, patch, agentId, agentName, 'onedrive_move', {
        fileId: args.file_id, newName: args.new_name, newParentId: args.new_parent_id,
      });
      if (!result.ok) return `Error moving/renaming OneDrive item: ${result.error}`;
      const data = result.data as { name?: string };
      return `OneDrive item updated${data?.name ? `: now named "${data.name}"` : ''}`;
    }

    case 'onedrive_upload_batch': {
      const filePaths = args.file_paths as string[];
      const folderId = args.folder_id as string | undefined;

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
          ? `me/drive/items/${encodeURIComponent(folderId)}:/${encodeURIComponent(fileName)}`
          : `me/drive/root:/${encodeURIComponent(fileName)}`;

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

    default:
      return `Unknown Microsoft write tool: ${name}`;
  }
}
