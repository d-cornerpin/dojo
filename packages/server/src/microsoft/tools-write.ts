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
    name: 'onedrive_upload',
    description: 'Upload a file to OneDrive (max 4MB). For larger files, use a different approach.',
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

    case 'onedrive_upload': {
      const filePath = args.file_path as string;
      const fileName = (args.name as string) ?? filePath.split('/').pop() ?? 'upload';
      const folderId = args.folder_id as string | undefined;

      // Read the local file
      const fs = await import('node:fs');
      if (!fs.existsSync(filePath)) return `Error: File not found at ${filePath}`;

      const stat = fs.statSync(filePath);
      if (stat.size > 4 * 1024 * 1024) return `Error: File is ${Math.round(stat.size / 1024 / 1024)}MB. OneDrive upload via this tool is limited to 4MB. Use a different approach for larger files.`;

      const content = fs.readFileSync(filePath);
      const token = (await import('./auth.js')).getAccessToken();
      if (!token) return 'Error: Not authenticated with Microsoft';

      const endpoint = folderId
        ? `https://graph.microsoft.com/v1.0/me/drive/items/${encodeURIComponent(folderId)}:/${encodeURIComponent(fileName)}:/content`
        : `https://graph.microsoft.com/v1.0/me/drive/root:/${encodeURIComponent(fileName)}:/content`;

      try {
        const resp = await fetch(endpoint, {
          method: 'PUT',
          headers: {
            Authorization: `Bearer ${token}`,
            'Content-Type': 'application/octet-stream',
          },
          body: content,
          signal: AbortSignal.timeout(60000),
        });

        if (!resp.ok) {
          const err = await resp.text();
          return `Error uploading to OneDrive: ${err.slice(0, 200)}`;
        }

        const data = await resp.json() as { id?: string; name?: string; webUrl?: string };
        return `File uploaded to OneDrive: ${data.name ?? fileName}${data.id ? ` (ID: ${data.id})` : ''}${data.webUrl ? `\nLink: ${data.webUrl}` : ''}`;
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
          roles: [],
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

      const result = await msGraphWrite('POST', `me/chats/${chatId}/messages`, {
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

    default:
      return `Unknown Microsoft write tool: ${name}`;
  }
}
