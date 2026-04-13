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
    description: 'Read recent Teams chat messages. Requires a Microsoft work/school account (Entra ID). Not available on personal Microsoft accounts.',
    input_schema: {
      type: 'object',
      properties: {
        chat_id: { type: 'string', description: 'Teams chat ID. Omit to list available chats instead.' },
        max_results: { type: 'number', description: 'How many messages to show (default: 10)' },
      },
      required: [],
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

      let output = `From: ${m.from?.emailAddress?.name} <${m.from?.emailAddress?.address}>\nTo: ${to}${cc ? `\nCc: ${cc}` : ''}\nSubject: ${m.subject}\nDate: ${m.receivedDateTime}\n\n${body.slice(0, 10000)}`;
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
            return `File: ${metaData.name}\n\n${text.slice(0, 50000)}`;
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

    default:
      return `Unknown Microsoft read tool: ${name}`;
  }
}
