// ════════════════════════════════════════
// Microsoft 365 READ Tools
// Available to: primary, trainer, ronin, apprentice
// NOT available to: PM agent
// ════════════════════════════════════════

import type { ToolDefinition } from '../agent/tools.js';
import { msGraphRead } from './client.js';

// ── Tool Definitions ──

export const microsoftReadToolDefinitions: ToolDefinition[] = [
  {
    name: 'outlook_search',
    description: 'Search Outlook email. Uses Microsoft search syntax.',
    input_schema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: "Search query (e.g., 'from:john@example.com', 'subject:invoice')" },
        max_results: { type: 'number', description: 'Maximum number of results (default: 10)' },
      },
      required: ['query'],
    },
  },
  {
    name: 'outlook_read',
    description: 'Read a specific Outlook email by message ID. Returns sender, recipients, subject, date, and body.',
    input_schema: {
      type: 'object',
      properties: {
        message_id: { type: 'string', description: 'Outlook message ID (from outlook_search or outlook_inbox results)' },
      },
      required: ['message_id'],
    },
  },
  {
    name: 'outlook_inbox',
    description: "Show recent Outlook inbox messages. Quick way to see what's new.",
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
    name: 'calendar_agenda_ms',
    description: "Show upcoming Microsoft Calendar events. Defaults to today's agenda.",
    input_schema: {
      type: 'object',
      properties: {
        days: { type: 'number', description: 'How many days ahead to show (1 = today, 7 = this week, default: 1)' },
      },
      required: [],
    },
  },
  {
    name: 'calendar_search_ms',
    description: 'Search Microsoft Calendar events by text.',
    input_schema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Search text to find in event subjects and descriptions' },
        days_ahead: { type: 'number', description: 'How far ahead to search in days (default: 30)' },
      },
      required: ['query'],
    },
  },
  {
    name: 'onedrive_list',
    description: 'List files in OneDrive. Can list root or a specific folder.',
    input_schema: {
      type: 'object',
      properties: {
        folder_id: { type: 'string', description: 'Folder ID to list (omit for root)' },
        max_results: { type: 'number', description: 'Maximum results (default: 20)' },
      },
      required: [],
    },
  },
  {
    name: 'onedrive_read',
    description: 'Read the content or metadata of a OneDrive file.',
    input_schema: {
      type: 'object',
      properties: {
        file_id: { type: 'string', description: 'OneDrive file ID (from onedrive_list results)' },
      },
      required: ['file_id'],
    },
  },
  {
    name: 'teams_read_messages',
    description: 'Read recent Teams chat messages (DMs and group chats). Requires a Microsoft work/school account (Entra ID). Not available on personal Microsoft accounts.',
    input_schema: {
      type: 'object',
      properties: {
        chat_id: { type: 'string', description: 'Teams chat ID. Omit to list available chats instead.' },
        max_results: { type: 'number', description: 'How many messages to show (default: 10)' },
      },
      required: [],
    },
  },
  {
    name: 'outlook_list_attachments',
    description: 'List attachments on an Outlook email. Use outlook_download_attachment to save one to disk.',
    input_schema: {
      type: 'object',
      properties: {
        message_id: { type: 'string', description: 'Outlook message ID (from outlook_search or outlook_inbox results)' },
      },
      required: ['message_id'],
    },
  },
  {
    name: 'onedrive_search',
    description: 'Search for files and folders in OneDrive by name or content.',
    input_schema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Search query (filename, keyword, or phrase)' },
        max_results: { type: 'number', description: 'Maximum results (default: 20)' },
      },
      required: ['query'],
    },
  },
  {
    name: 'teams_list_teams',
    description: 'List all Microsoft Teams you are a member of. Requires Entra ID. Use teams_list_channels after to see channels inside a team.',
    input_schema: {
      type: 'object',
      properties: {},
      required: [],
    },
  },
  {
    name: 'teams_list_channels',
    description: 'List all channels in a Microsoft Team. Requires Entra ID. Use teams_read_channel_messages or teams_send_channel_message with the channel ID.',
    input_schema: {
      type: 'object',
      properties: {
        team_id: { type: 'string', description: 'Team ID (from teams_list_teams results)' },
      },
      required: ['team_id'],
    },
  },
  {
    name: 'teams_read_channel_messages',
    description: 'Read recent messages from a Microsoft Teams channel. Requires Entra ID and channel membership.',
    input_schema: {
      type: 'object',
      properties: {
        team_id: { type: 'string', description: 'Team ID (from teams_list_teams)' },
        channel_id: { type: 'string', description: 'Channel ID (from teams_list_channels)' },
        max_results: { type: 'number', description: 'How many messages to show (default: 10)' },
      },
      required: ['team_id', 'channel_id'],
    },
  },
];

// ── Tool Execution ──

export async function executeMicrosoftReadTool(
  name: string,
  args: Record<string, unknown>,
  agentId: string,
  agentName: string,
): Promise<string> {
  switch (name) {
    case 'outlook_search': {
      const query = args.query as string;
      const maxResults = (args.max_results as number) ?? 10;
      const result = await msGraphRead(
        `me/messages?$search="${encodeURIComponent(query)}"&$top=${maxResults}&$select=id,from,subject,receivedDateTime,bodyPreview,isRead`,
        agentId, agentName, 'outlook_search', { query, maxResults },
      );
      if (!result.ok) return `Error searching Outlook: ${result.error}`;

      const data = result.data as { value?: Array<{ id: string; from: { emailAddress: { name: string; address: string } }; subject: string; receivedDateTime: string; bodyPreview: string; isRead: boolean }> };
      if (!data?.value || data.value.length === 0) return 'No emails found matching that query.';

      const emails = data.value.map(m => {
        const unread = m.isRead ? '' : ' [UNREAD]';
        return `${unread}ID: ${m.id}\nFrom: ${m.from?.emailAddress?.name} <${m.from?.emailAddress?.address}>\nSubject: ${m.subject}\nDate: ${m.receivedDateTime}\nPreview: ${m.bodyPreview}`;
      });

      return `Found ${data.value.length} email(s):\n\n${emails.join('\n\n---\n\n')}`;
    }

    case 'outlook_read': {
      const messageId = encodeURIComponent(args.message_id as string);
      const result = await msGraphRead(
        `me/messages/${messageId}?$select=id,from,toRecipients,ccRecipients,subject,receivedDateTime,body,hasAttachments`,
        agentId, agentName, 'outlook_read', { messageId: args.message_id },
      );
      if (!result.ok) return `Error reading email: ${result.error}`;

      const m = result.data as {
        id: string;
        from: { emailAddress: { name: string; address: string } };
        toRecipients: Array<{ emailAddress: { name: string; address: string } }>;
        ccRecipients?: Array<{ emailAddress: { name: string; address: string } }>;
        subject: string;
        receivedDateTime: string;
        body: { contentType: string; content: string };
        hasAttachments: boolean;
      };

      const to = m.toRecipients?.map(r => `${r.emailAddress.name} <${r.emailAddress.address}>`).join(', ') ?? '';
      const cc = m.ccRecipients?.map(r => `${r.emailAddress.name} <${r.emailAddress.address}>`).join(', ') ?? '';
      // Strip HTML tags for readability
      let body = m.body?.content ?? '';
      if (m.body?.contentType === 'html') {
        body = body.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
      }

      let output = `From: ${m.from?.emailAddress?.name} <${m.from?.emailAddress?.address}>\nTo: ${to}${cc ? `\nCc: ${cc}` : ''}\nSubject: ${m.subject}\nDate: ${m.receivedDateTime}\n\n${body}`;
      if (m.hasAttachments) output += '\n\nAttachments: yes';
      return output;
    }

    case 'outlook_inbox': {
      const maxResults = (args.max_results as number) ?? 10;
      const unreadOnly = args.unread_only === true;
      const filter = unreadOnly ? "&$filter=isRead eq false" : '';
      const result = await msGraphRead(
        `me/mailFolders/inbox/messages?$top=${maxResults}${filter}&$orderby=receivedDateTime desc&$select=id,from,subject,receivedDateTime,bodyPreview,isRead`,
        agentId, agentName, 'outlook_inbox', { maxResults, unreadOnly },
      );
      if (!result.ok) return `Error fetching inbox: ${result.error}`;

      const data = result.data as { value?: Array<{ id: string; from: { emailAddress: { name: string; address: string } }; subject: string; receivedDateTime: string; bodyPreview: string; isRead: boolean }> };
      if (!data?.value || data.value.length === 0) return unreadOnly ? 'No unread messages in inbox.' : 'Inbox is empty.';

      const emails = data.value.map(m => {
        const unread = m.isRead ? '' : ' [UNREAD]';
        return `${unread}ID: ${m.id} | From: ${m.from?.emailAddress?.name} <${m.from?.emailAddress?.address}> | Subject: ${m.subject} | Date: ${m.receivedDateTime}`;
      });

      return `Inbox (${data.value.length} messages):\n\n${emails.join('\n')}`;
    }

    case 'calendar_agenda_ms': {
      const days = (args.days as number) ?? 1;
      const now = new Date();
      const end = new Date(now.getTime() + days * 86400000);
      const result = await msGraphRead(
        `me/calendarView?startDateTime=${now.toISOString()}&endDateTime=${end.toISOString()}&$orderby=start/dateTime&$select=id,subject,start,end,location,bodyPreview`,
        agentId, agentName, 'calendar_agenda_ms', { days },
      );
      if (!result.ok) return `Error fetching calendar: ${result.error}`;

      const data = result.data as { value?: Array<{ id: string; subject: string; start: { dateTime: string }; end: { dateTime: string }; location?: { displayName?: string }; bodyPreview?: string }> };
      if (!data?.value || data.value.length === 0) return `No events in the next ${days} day(s).`;

      const events = data.value.map(e => {
        let line = `- ${e.subject} (${e.start.dateTime} to ${e.end.dateTime})`;
        if (e.location?.displayName) line += `\n  Location: ${e.location.displayName}`;
        if (e.bodyPreview) line += `\n  Notes: ${e.bodyPreview.slice(0, 200)}`;
        line += `\n  ID: ${e.id}`;
        return line;
      });

      return `Calendar agenda (next ${days} day(s)):\n\n${events.join('\n\n')}`;
    }

    case 'calendar_search_ms': {
      const query = args.query as string;
      const daysAhead = (args.days_ahead as number) ?? 30;
      const now = new Date();
      const end = new Date(now.getTime() + daysAhead * 86400000);
      const result = await msGraphRead(
        `me/calendarView?startDateTime=${now.toISOString()}&endDateTime=${end.toISOString()}&$filter=contains(subject,'${encodeURIComponent(query)}')&$select=id,subject,start,end`,
        agentId, agentName, 'calendar_search_ms', { query, daysAhead },
      );
      if (!result.ok) return `Error searching calendar: ${result.error}`;

      const data = result.data as { value?: Array<{ id: string; subject: string; start: { dateTime: string } }> };
      if (!data?.value || data.value.length === 0) return `No events matching "${query}" in the next ${daysAhead} days.`;

      const events = data.value.map(e => `- ${e.subject} (${e.start.dateTime}) [ID: ${e.id}]`);
      return `Found ${data.value.length} event(s) matching "${query}":\n\n${events.join('\n')}`;
    }

    case 'onedrive_list': {
      const folderId = args.folder_id as string | undefined;
      const maxResults = (args.max_results as number) ?? 20;
      const endpoint = folderId
        ? `me/drive/items/${encodeURIComponent(folderId)}/children?$top=${maxResults}&$select=id,name,size,lastModifiedDateTime,file,folder`
        : `me/drive/root/children?$top=${maxResults}&$select=id,name,size,lastModifiedDateTime,file,folder`;

      const result = await msGraphRead(endpoint, agentId, agentName, 'onedrive_list', { folderId, maxResults });
      if (!result.ok) return `Error listing OneDrive: ${result.error}`;

      const data = result.data as { value?: Array<{ id: string; name: string; size?: number; lastModifiedDateTime: string; file?: { mimeType: string }; folder?: { childCount: number } }> };
      if (!data?.value || data.value.length === 0) return 'No files found.';

      const files = data.value.map(f => {
        const type = f.folder ? `Folder (${f.folder.childCount} items)` : (f.file?.mimeType ?? 'File');
        const size = f.size ? ` (${Math.round(f.size / 1024)}KB)` : '';
        return `- ${f.name}${size}\n  ID: ${f.id}\n  Type: ${type}\n  Modified: ${f.lastModifiedDateTime}`;
      });

      return `Found ${data.value.length} item(s):\n\n${files.join('\n\n')}`;
    }

    case 'onedrive_read': {
      const fileId = encodeURIComponent(args.file_id as string);
      // First get metadata
      const meta = await msGraphRead(
        `me/drive/items/${fileId}?$select=id,name,size,file`,
        agentId, agentName, 'onedrive_read', { fileId: args.file_id },
      );
      if (!meta.ok) return `Error reading file: ${meta.error}`;

      const metaData = meta.data as { id: string; name: string; size?: number; file?: { mimeType: string } };

      // For text-based files, download content
      const mimeType = metaData?.file?.mimeType ?? '';
      if (mimeType.startsWith('text/') || mimeType.includes('json') || mimeType.includes('xml') || mimeType.includes('csv')) {
        try {
          const token = (await import('./auth.js')).getAccessToken();
          const resp = await fetch(`https://graph.microsoft.com/v1.0/me/drive/items/${fileId}/content`, {
            headers: { Authorization: `Bearer ${token}` },
            signal: AbortSignal.timeout(30000),
          });
          if (resp.ok) {
            const text = await resp.text();
            return `File: ${metaData.name}\n\n${text}`;
          }
        } catch { /* fall through to metadata */ }
      }

      return `File: ${metaData.name}\nSize: ${metaData.size ? Math.round(metaData.size / 1024) + 'KB' : 'unknown'}\nType: ${mimeType || 'unknown'}\n\n(Binary file — use onedrive download or view in browser)`;
    }

    case 'teams_read_messages': {
      const chatId = args.chat_id as string | undefined;
      const maxResults = (args.max_results as number) ?? 10;

      // If no chat_id, list available chats
      if (!chatId) {
        const result = await msGraphRead(
          `me/chats?$top=20&$select=id,topic,chatType,lastUpdatedDateTime`,
          agentId, agentName, 'teams_list_chats', {},
        );
        if (!result.ok) return `Error listing Teams chats: ${result.error}`;

        const data = result.data as { value?: Array<{ id: string; topic: string | null; chatType: string; lastUpdatedDateTime: string }> };
        if (!data?.value || data.value.length === 0) return 'No Teams chats found.';

        const chats = data.value.map(c =>
          `- ${c.topic ?? '(untitled)'} [${c.chatType}]\n  ID: ${c.id}\n  Last updated: ${c.lastUpdatedDateTime}`
        );
        return `Teams chats:\n\n${chats.join('\n\n')}\n\nUse teams_read_messages with a chat_id to read messages.`;
      }

      const result = await msGraphRead(
        `chats/${encodeURIComponent(chatId)}/messages?$top=${maxResults}&$orderby=createdDateTime desc`,
        agentId, agentName, 'teams_read_messages', { chatId, maxResults },
      );
      if (!result.ok) return `Error reading Teams messages: ${result.error}`;

      const data = result.data as { value?: Array<{ id: string; from?: { user?: { displayName: string } }; body: { content: string; contentType: string }; createdDateTime: string }> };
      if (!data?.value || data.value.length === 0) return 'No messages in this chat.';

      const messages = data.value.map(m => {
        const sender = m.from?.user?.displayName ?? 'Unknown';
        let body = m.body?.content ?? '';
        if (m.body?.contentType === 'html') body = body.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
        return `[${m.createdDateTime}] ${sender}: ${body.slice(0, 500)}`;
      });

      return `Teams messages:\n\n${messages.join('\n\n')}`;
    }

    case 'outlook_list_attachments': {
      const messageId = encodeURIComponent(args.message_id as string);
      const result = await msGraphRead(
        `me/messages/${messageId}/attachments?$select=id,name,contentType,size,isInline`,
        agentId, agentName, 'outlook_list_attachments', { messageId: args.message_id },
      );
      if (!result.ok) return `Error listing attachments: ${result.error}`;

      const data = result.data as { value?: Array<{ id: string; name: string; contentType: string; size: number; isInline: boolean }> };
      if (!data?.value || data.value.length === 0) return 'No attachments on this email.';

      const items = data.value
        .filter(a => !a.isInline)
        .map(a => `- ${a.name} (${Math.round(a.size / 1024)}KB, ${a.contentType})\n  ID: ${a.id}`);

      if (items.length === 0) return 'No non-inline attachments on this email.';
      return `Attachments (${items.length}):\n\n${items.join('\n\n')}\n\nUse outlook_download_attachment with the message ID and attachment ID to save to local disk.`;
    }

    case 'onedrive_search': {
      const query = args.query as string;
      const maxResults = (args.max_results as number) ?? 20;

      const result = await msGraphRead(
        `me/drive/root/search(q='${encodeURIComponent(query)}')?$top=${maxResults}&$select=id,name,size,lastModifiedDateTime,file,folder`,
        agentId, agentName, 'onedrive_search', { query, maxResults },
      );
      if (!result.ok) return `Error searching OneDrive: ${result.error}`;

      const data = result.data as { value?: Array<{ id: string; name: string; size?: number; lastModifiedDateTime: string; file?: { mimeType: string }; folder?: { childCount: number } }> };
      if (!data?.value || data.value.length === 0) return `No files found matching "${query}".`;

      const files = data.value.map(f => {
        const type = f.folder ? `Folder (${f.folder.childCount} items)` : (f.file?.mimeType ?? 'File');
        const size = f.size ? ` (${Math.round(f.size / 1024)}KB)` : '';
        return `- ${f.name}${size}\n  ID: ${f.id}\n  Type: ${type}\n  Modified: ${f.lastModifiedDateTime}`;
      });

      return `Found ${data.value.length} result(s) for "${query}":\n\n${files.join('\n\n')}`;
    }

    case 'teams_list_teams': {
      const result = await msGraphRead(
        'me/joinedTeams?$select=id,displayName,description',
        agentId, agentName, 'teams_list_teams', {},
      );
      if (!result.ok) return `Error listing Teams: ${result.error}`;

      const data = result.data as { value?: Array<{ id: string; displayName: string; description?: string }> };
      if (!data?.value || data.value.length === 0) {
        return 'No Teams found. (Requires a Microsoft work/school account and membership in at least one Team.)';
      }

      const teams = data.value.map(t =>
        `- ${t.displayName}\n  ID: ${t.id}${t.description ? `\n  ${t.description}` : ''}`
      );
      return `Teams you are a member of:\n\n${teams.join('\n\n')}\n\nUse teams_list_channels with a team_id to see channels.`;
    }

    case 'teams_list_channels': {
      const teamId = encodeURIComponent(args.team_id as string);

      const result = await msGraphRead(
        `teams/${teamId}/channels?$select=id,displayName,description`,
        agentId, agentName, 'teams_list_channels', { teamId: args.team_id },
      );
      if (!result.ok) return `Error listing channels: ${result.error}`;

      const data = result.data as { value?: Array<{ id: string; displayName: string; description?: string }> };
      if (!data?.value || data.value.length === 0) return 'No channels found in this Team.';

      const channels = data.value.map(c =>
        `- ${c.displayName}\n  ID: ${c.id}${c.description ? `\n  ${c.description}` : ''}`
      );
      return `Channels:\n\n${channels.join('\n\n')}\n\nUse teams_read_channel_messages or teams_send_channel_message with both team_id and channel_id.`;
    }

    case 'teams_read_channel_messages': {
      const teamId = encodeURIComponent(args.team_id as string);
      const channelId = encodeURIComponent(args.channel_id as string);
      const maxResults = (args.max_results as number) ?? 10;

      const result = await msGraphRead(
        `teams/${teamId}/channels/${channelId}/messages?$top=${maxResults}`,
        agentId, agentName, 'teams_read_channel_messages', { teamId: args.team_id, channelId: args.channel_id, maxResults },
      );
      if (!result.ok) return `Error reading channel messages: ${result.error}`;

      const data = result.data as { value?: Array<{ id: string; from?: { user?: { displayName: string } }; body: { content: string; contentType: string }; createdDateTime: string }> };
      if (!data?.value || data.value.length === 0) return 'No messages in this channel.';

      const messages = data.value.map(m => {
        const sender = m.from?.user?.displayName ?? 'Unknown';
        let body = m.body?.content ?? '';
        if (m.body?.contentType === 'html') body = body.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
        return `[${m.createdDateTime}] ${sender}: ${body.slice(0, 500)}`;
      });

      return `Channel messages (newest first):\n\n${messages.join('\n\n')}`;
    }

    default:
      return `Unknown Microsoft read tool: ${name}`;
  }
}
