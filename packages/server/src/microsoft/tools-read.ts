// ════════════════════════════════════════
// Microsoft 365 READ Tools
// Available to: primary, trainer, ronin, apprentice
// NOT available to: PM agent
// ════════════════════════════════════════

import type { ToolDefinition } from '../agent/tools.js';
import { msGraphRead, calendarPrefix, drivePrefix } from './client.js';

// ── Tool Definitions ──

export const microsoftReadToolDefinitions: ToolDefinition[] = [
  {
    name: 'outlook_search',
    description: 'Search Outlook email. Default returns one compact line per email (date | sender — subject + ID + unread flag). For previews on every result, pass verbose=true; for the full body of ONE email, use outlook_read(message_id).',
    input_schema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: "Search query (e.g., 'from:john@example.com', 'subject:invoice')" },
        max_results: { type: 'number', description: 'Maximum number of results (default: 10)' },
        verbose: { type: 'boolean', description: 'If true, include the body preview per email. Default false (one line per result).' },
      },
      required: ['query'],
    },
    concurrency: 'safe',
    maxResultTokens: 3000,
  },
  {
    name: 'outlook_read',
    description:
      'Read a specific Outlook email by message ID. Returns sender, recipients, subject, date, and plain-text body (HTML stripped). Body is paginated: defaults to first ~12K chars (~3K tokens). For long emails, use `offset` + `limit` (in characters) — the pagination trailer tells you the exact next call.',
    input_schema: {
      type: 'object',
      properties: {
        message_id: { type: 'string', description: 'Outlook message ID (from outlook_search or outlook_inbox results)' },
        offset: { type: 'number', description: 'Body character offset to start from (default 0). Use the value from the previous call\'s pagination trailer.' },
        limit: { type: 'number', description: 'Body characters to return (default 12000 ≈ 3K tokens). Don\'t exceed 16000.' },
      },
      required: ['message_id'],
    },
    concurrency: 'safe',
    maxResultTokens: 4000,
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
    concurrency: 'safe',
    maxResultTokens: 3000,
  },
  {
    name: 'calendar_agenda_ms',
    description: "Show upcoming Microsoft Calendar events. Defaults to today's agenda on your default calendar. Pass calendar_id to read from a shared calendar (use calendar_list_ms to find IDs). When a user asks about a specific local day (e.g. \"events for Wednesday\"), pass start_date + timezone so the window aligns to local midnight rather than UTC — otherwise late-evening events that have already crossed into the next day in UTC will be missed.",
    input_schema: {
      type: 'object',
      properties: {
        days: { type: 'number', description: 'How many days to span (1 = a single day, 7 = a week, default 1).' },
        timezone: { type: 'string', description: 'IANA timezone (e.g. "America/Los_Angeles"). Defaults to the system timezone. When set, the window snaps to local midnight in this timezone.' },
        start_date: { type: 'string', description: 'Anchor the window to a specific local date in YYYY-MM-DD (interpreted in `timezone`). Use this when the user asks about a specific day — compute the date, then pass it here. Omit to default to "today" in the given timezone.' },
        calendar_id: { type: 'string', description: 'Calendar to read from. Two forms: (1) a calendar UUID from calendar_list_ms — for own + accepted shared calendars; (2) an email address like "owner@example.com" — for direct delegate access to someone else\'s calendar that has been shared with you (no Outlook UI acceptance required, just the share grant). Defaults to your default calendar.' },
      },
      required: [],
    },
    concurrency: 'safe',
    maxResultTokens: 2000,
  },
  {
    name: 'calendar_search_ms',
    description: 'Search Microsoft Calendar events by text. Pass calendar_id to search a shared calendar. Pass start_date + timezone when constraining to a specific local day.',
    input_schema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Search text to find in event subjects and descriptions' },
        days_ahead: { type: 'number', description: 'How far ahead to search in days (default: 30)' },
        timezone: { type: 'string', description: 'IANA timezone for the search window (e.g. "America/Los_Angeles"). Defaults to system timezone.' },
        start_date: { type: 'string', description: 'Anchor the window to a specific local date in YYYY-MM-DD. Defaults to "today" in the given timezone.' },
        calendar_id: { type: 'string', description: 'Calendar to search. Calendar UUID OR an email for delegate access. Defaults to your default calendar.' },
      },
      required: ['query'],
    },
    concurrency: 'safe',
    maxResultTokens: 2000,
  },
  {
    name: 'calendar_list_ms',
    description: 'List all Microsoft calendars you have access to, including shared calendars. Returns each calendar with its ID, name, owner, and your permissions (canEdit, canShare, canViewPrivateItems). Use the returned IDs with calendar_agenda_ms, calendar_create_ms, etc.',
    input_schema: {
      type: 'object',
      properties: {},
      required: [],
    },
    concurrency: 'safe',
    maxResultTokens: 2000,
  },
  {
    name: 'calendar_share_invites_ms',
    description: 'List pending calendar-sharing invitation emails in your inbox (someone shared their calendar with you and you haven\'t accepted yet). Returns each invite\'s message ID, sender, subject, and shared-calendar info. Use calendar_accept_share_ms with a returned message_id to accept programmatically.',
    input_schema: {
      type: 'object',
      properties: {
        max: { type: 'number', description: 'Max invites to return (default 20)' },
      },
      required: [],
    },
    concurrency: 'safe',
    maxResultTokens: 2000,
  },
  {
    name: 'onedrive_list',
    description: 'List files in OneDrive (your personal drive by default). Pass drive_id to list a shared OneDrive item or a SharePoint document library — get drive_ids from onedrive_list_shared, sharepoint_list_drives, or onedrive_list_drives. Default returns one compact line per item.',
    input_schema: {
      type: 'object',
      properties: {
        folder_id: { type: 'string', description: 'Folder ID to list (omit for the drive root)' },
        max_results: { type: 'number', description: 'Maximum results (default: 20)' },
        verbose: { type: 'boolean', description: 'If true, include full mime type and webUrl per item. Default false (compact rows).' },
        drive_id: { type: 'string', description: 'Drive to list. Defaults to your personal OneDrive. Use a drive_id from onedrive_list_shared / sharepoint_list_drives to access a shared drive or SharePoint library.' },
      },
      required: [],
    },
    concurrency: 'safe',
    maxResultTokens: 3000,
  },
  {
    name: 'onedrive_read',
    description: 'Read the content or metadata of a file. Defaults to your personal OneDrive; pass drive_id to read from a shared drive or SharePoint library. Text content is paginated by character — defaults to first ~16K chars.',
    input_schema: {
      type: 'object',
      properties: {
        file_id: { type: 'string', description: 'File ID (from onedrive_list / onedrive_search / onedrive_list_shared)' },
        offset: { type: 'number', description: 'Character offset to start from (default 0).' },
        limit: { type: 'number', description: 'Characters to return (default 16000 ≈ 4K tokens). Don\'t exceed 20000.' },
        drive_id: { type: 'string', description: 'Drive the file lives on. Defaults to your personal OneDrive.' },
      },
      required: ['file_id'],
    },
    concurrency: 'safe',
    maxResultTokens: 5000,
  },
  {
    name: 'onedrive_list_shared',
    description: 'List files shared with you on OneDrive (other people gave you access). Returns each item with its drive_id and file_id — pass both to onedrive_read / onedrive_list / onedrive_upload / etc. to operate on the shared file.',
    input_schema: {
      type: 'object',
      properties: {
        max_results: { type: 'number', description: 'Maximum results (default: 30)' },
      },
      required: [],
    },
    concurrency: 'safe',
    maxResultTokens: 3000,
  },
  {
    name: 'onedrive_list_drives',
    description: 'List all drives you can access — your personal OneDrive plus any shared drives surfaced by Microsoft Graph. Returns each drive with its drive_id, name, and owner. For SharePoint document libraries use sharepoint_list_drives instead.',
    input_schema: {
      type: 'object',
      properties: {},
      required: [],
    },
    concurrency: 'safe',
    maxResultTokens: 2000,
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
    concurrency: 'safe',
    maxResultTokens: 3000,
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
    concurrency: 'safe',
    maxResultTokens: 1500,
  },
  {
    name: 'onedrive_search',
    description: 'Search for files and folders by name or content. Defaults to your personal OneDrive; pass drive_id to search a shared drive or SharePoint library.',
    input_schema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Search query (filename, keyword, or phrase)' },
        max_results: { type: 'number', description: 'Maximum results (default: 20)' },
        drive_id: { type: 'string', description: 'Drive to search. Defaults to your personal OneDrive.' },
      },
      required: ['query'],
    },
    concurrency: 'safe',
    maxResultTokens: 3000,
  },
  {
    name: 'sharepoint_list_sites',
    description: 'List or search SharePoint sites you have access to. Pass query to filter; omit for a list of recent/followed sites. Returns each site with its site_id and webUrl. Use sharepoint_list_drives(site_id) to find document libraries inside a site.',
    input_schema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Optional search text to filter sites by name.' },
        max_results: { type: 'number', description: 'Maximum results (default: 20)' },
      },
      required: [],
    },
    concurrency: 'safe',
    maxResultTokens: 2500,
  },
  {
    name: 'sharepoint_list_drives',
    description: 'List document libraries (drives) inside a SharePoint site. Returns each drive with its drive_id and name. Use the drive_id with onedrive_list / onedrive_read / onedrive_upload / etc. to operate on files in that library.',
    input_schema: {
      type: 'object',
      properties: {
        site_id: { type: 'string', description: 'SharePoint site ID (from sharepoint_list_sites)' },
      },
      required: ['site_id'],
    },
    concurrency: 'safe',
    maxResultTokens: 2000,
  },
  {
    name: 'online_meeting_get',
    description: 'Get the full details of a Teams online meeting (including the join URL). Use online_meeting_create first or pass an existing meeting_id.',
    input_schema: {
      type: 'object',
      properties: {
        meeting_id: { type: 'string', description: 'Online meeting ID (from online_meeting_create or a stored reference)' },
      },
      required: ['meeting_id'],
    },
    concurrency: 'safe',
    maxResultTokens: 1500,
  },
  {
    name: 'teams_list_teams',
    description: 'List all Microsoft Teams you are a member of. Requires Entra ID. Use teams_list_channels after to see channels inside a team.',
    input_schema: {
      type: 'object',
      properties: {},
      required: [],
    },
    concurrency: 'safe',
    maxResultTokens: 2000,
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
    concurrency: 'safe',
    maxResultTokens: 2000,
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
    concurrency: 'safe',
    maxResultTokens: 3000,
  },
];

// Phase 3.5 (2026-05-04) — register concurrency + maxResultTokens overrides
// with the v2 partitioner / cap registry. tools.ts imports this module
// statically, so registration happens at app startup.
import { registerConcurrency, registerMaxResultTokens } from '../agent/v2/classifiers/concurrency.js';
for (const def of microsoftReadToolDefinitions) {
  if (def.concurrency) registerConcurrency(def.name, def.concurrency);
  if (def.maxResultTokens) registerMaxResultTokens(def.name, def.maxResultTokens);
}

// ── Tool Execution ──

const microsoftReadToolDefByName = new Map(microsoftReadToolDefinitions.map(t => [t.name, t]));

export async function executeMicrosoftReadTool(
  name: string,
  args: Record<string, unknown>,
  agentId: string,
  agentName: string,
): Promise<string> {
  // Schema-driven required-field validation. Same approach as Slides — keeps
  // validation co-located with the tool definitions.
  const { validateAgainstSchema } = await import('../agent/tool-helpers.js');
  const def = microsoftReadToolDefByName.get(name);
  const schemaErr = validateAgainstSchema(name, def?.input_schema as Parameters<typeof validateAgainstSchema>[1], args);
  if (schemaErr) return schemaErr;

  switch (name) {
    case 'outlook_search': {
      const query = args.query as string;
      const maxResults = (args.max_results as number) ?? 10;
      const verbose = args.verbose as boolean | undefined;
      const result = await msGraphRead(
        `me/messages?$search="${encodeURIComponent(query)}"&$top=${maxResults}&$select=id,from,subject,receivedDateTime,bodyPreview,isRead`,
        agentId, agentName, 'outlook_search', { query, maxResults },
      );
      if (!result.ok) return `Error searching Outlook: ${result.error}`;

      const data = result.data as { value?: Array<{ id: string; from: { emailAddress: { name: string; address: string } }; subject: string; receivedDateTime: string; bodyPreview: string; isRead: boolean }> };
      if (!data?.value || data.value.length === 0) return 'No emails found matching that query.';

      const { formatTimeForAgent } = await import('../services/format-time.js');
      const emails = data.value.map(m => {
        const unread = m.isRead ? ' [UNREAD]' : '';
        const fromName = m.from?.emailAddress?.name ?? '';
        const fromAddr = m.from?.emailAddress?.address ?? '';
        const when = formatTimeForAgent(m.receivedDateTime);
        if (verbose) {
          return `${unread.trim()}ID: ${m.id}\nFrom: ${fromName} <${fromAddr}>\nSubject: ${m.subject}\nDate: ${when}\nPreview: ${m.bodyPreview}`;
        }
        // Compact: one line per email — drop preview body, keep date+sender+subject+unread.
        return `-${unread} ${when} | ${fromName} <${fromAddr}> — ${m.subject}\n  ID: ${m.id}`;
      });

      const header = `Found ${data.value.length} email(s):\n\n${emails.join(verbose ? '\n\n---\n\n' : '\n')}`;
      if (verbose) return header;
      return `${header}\n\n${emails.length} compact result${emails.length === 1 ? '' : 's'} shown. For full body of one: outlook_read(message_id=<id>). For previews on every result: re-call outlook_search with verbose=true.`;
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

      // Phase 3.5 (2026-05-04) — paginated body. Headers always included; the
      // body slices to ~12K chars by default with offset/limit pagination.
      const { applyTextPagination } = await import('../agent/tools.js');
      const pagedBody = applyTextPagination(
        body,
        'outlook_read',
        { offset: args.offset as number | undefined, limit: args.limit as number | undefined },
        { message_id: args.message_id },
        12_000,
      );

      const { formatTimeForAgent: fmtTime1 } = await import('../services/format-time.js');
      let output = `From: ${m.from?.emailAddress?.name} <${m.from?.emailAddress?.address}>\nTo: ${to}${cc ? `\nCc: ${cc}` : ''}\nSubject: ${m.subject}\nDate: ${fmtTime1(m.receivedDateTime)}\n\n${pagedBody}`;
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

      const { formatTimeForAgent: fmtTime2 } = await import('../services/format-time.js');
      const emails = data.value.map(m => {
        const unread = m.isRead ? '' : ' [UNREAD]';
        return `${unread}ID: ${m.id} | From: ${m.from?.emailAddress?.name} <${m.from?.emailAddress?.address}> | Subject: ${m.subject} | Date: ${fmtTime2(m.receivedDateTime)}`;
      });

      return `Inbox (${data.value.length} messages):\n\n${emails.join('\n')}`;
    }

    case 'calendar_agenda_ms': {
      const days = (args.days as number) ?? 1;
      const calendarId = args.calendar_id as string | undefined;
      const startDate = args.start_date as string | undefined;
      const requestedTz = (args.timezone as string | undefined);
      const { computeCalendarWindow } = await import('../services/calendar-window.js');
      const window = computeCalendarWindow({ days, timezone: requestedTz, start_date: startDate });
      const result = await msGraphRead(
        `${calendarPrefix(calendarId)}calendarView?startDateTime=${window.startISO}&endDateTime=${window.endISO}&$orderby=start/dateTime&$select=id,subject,start,end,location,bodyPreview,isAllDay`,
        agentId, agentName, 'calendar_agenda_ms', { days, calendarId, startDate, anchored: window.anchored },
      );
      if (!result.ok) return `Error fetching calendar: ${result.error}`;

      const data = result.data as { value?: Array<{ id: string; subject: string; start: { dateTime: string; timeZone?: string }; end: { dateTime: string; timeZone?: string }; location?: { displayName?: string }; bodyPreview?: string; isAllDay?: boolean }> };
      if (!data?.value || data.value.length === 0) return `No events in the next ${days} day(s).`;

      // Microsoft Graph returns start/end as naked ISO ("2026-05-20T19:00:00.0000000")
      // with no timezone suffix. The timeZone field on each side tells us
      // what zone to interpret it as (defaults to UTC). Without conversion
      // the agent reads the raw string as its own local time and gets
      // every event wrong. Route everything through formatTimeRangeForAgent.
      const { parseFlexibleTime, formatTimeRangeForAgent } = await import('../services/format-time.js');
      const events = data.value.map(e => {
        const startTz = e.start.timeZone || 'UTC';
        const endTz = e.end.timeZone || 'UTC';
        const startDate = parseFlexibleTime(e.start.dateTime, startTz);
        const endDate = parseFlexibleTime(e.end.dateTime, endTz);
        const when = startDate && endDate
          ? formatTimeRangeForAgent(startDate, endDate, { timezone: requestedTz, allDay: e.isAllDay === true })
          : `${e.start.dateTime} to ${e.end.dateTime} (could not parse)`;
        let line = `- ${e.subject}\n  ${when}`;
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
      const calendarId = args.calendar_id as string | undefined;
      const startDate = args.start_date as string | undefined;
      const requestedTz = (args.timezone as string | undefined);
      const { computeCalendarWindow } = await import('../services/calendar-window.js');
      const window = computeCalendarWindow({ days: daysAhead, timezone: requestedTz, start_date: startDate });
      const result = await msGraphRead(
        `${calendarPrefix(calendarId)}calendarView?startDateTime=${window.startISO}&endDateTime=${window.endISO}&$filter=contains(subject,'${encodeURIComponent(query)}')&$select=id,subject,start,end,isAllDay`,
        agentId, agentName, 'calendar_search_ms', { query, daysAhead, calendarId, startDate, anchored: window.anchored },
      );
      if (!result.ok) return `Error searching calendar: ${result.error}`;

      const data = result.data as { value?: Array<{ id: string; subject: string; start: { dateTime: string; timeZone?: string }; end?: { dateTime: string; timeZone?: string }; isAllDay?: boolean }> };
      if (!data?.value || data.value.length === 0) return `No events matching "${query}" in the next ${daysAhead} days.`;

      const { parseFlexibleTime, formatTimeForAgent } = await import('../services/format-time.js');
      const events = data.value.map(e => {
        const tz = e.start.timeZone || 'UTC';
        const startDate = parseFlexibleTime(e.start.dateTime, tz);
        const when = startDate
          ? formatTimeForAgent(startDate, { timezone: requestedTz, allDay: e.isAllDay === true })
          : `${e.start.dateTime} (could not parse)`;
        return `- ${e.subject}\n  ${when}\n  [ID: ${e.id}]`;
      });
      return `Found ${data.value.length} event(s) matching "${query}":\n\n${events.join('\n')}`;
    }

    case 'calendar_list_ms': {
      const result = await msGraphRead(
        'me/calendars?$select=id,name,owner,canEdit,canShare,canViewPrivateItems,isDefaultCalendar,color',
        agentId, agentName, 'calendar_list_ms', {},
      );
      if (!result.ok) return `Error listing calendars: ${result.error}`;
      const data = result.data as { value?: Array<{ id: string; name: string; owner?: { name?: string; address?: string }; canEdit?: boolean; canShare?: boolean; canViewPrivateItems?: boolean; isDefaultCalendar?: boolean }> };
      if (!data?.value || data.value.length === 0) return 'No calendars accessible.';
      const lines = data.value.map(c => {
        const perms: string[] = [];
        if (c.isDefaultCalendar) perms.push('default');
        if (c.canEdit) perms.push('canEdit');
        if (c.canShare) perms.push('canShare');
        if (c.canViewPrivateItems) perms.push('canViewPrivateItems');
        const ownerStr = c.owner?.name || c.owner?.address ? ` (owner: ${c.owner.name ?? c.owner.address})` : '';
        return `- ${c.name}${ownerStr} [${perms.join(', ') || 'read-only'}]\n  ID: ${c.id}`;
      });
      return `${data.value.length} calendar(s):\n\n${lines.join('\n')}`;
    }

    case 'calendar_share_invites_ms': {
      const max = (args.max as number) ?? 20;
      // Calendar-sharing invitations arrive as messages with itemClass
      // 'IPM.Sharing'. Filter to surface them so the agent can list and
      // accept them via calendar_accept_share_ms.
      const result = await msGraphRead(
        `me/messages?$top=${max}&$filter=startswith(itemClass,'IPM.Sharing')&$select=id,subject,from,receivedDateTime,bodyPreview,itemClass`,
        agentId, agentName, 'calendar_share_invites_ms', { max },
      );
      if (!result.ok) return `Error listing share invites: ${result.error}`;
      const data = result.data as { value?: Array<{ id: string; subject: string; from?: { emailAddress?: { name?: string; address?: string } }; receivedDateTime: string; bodyPreview?: string }> };
      if (!data?.value || data.value.length === 0) return 'No pending calendar share invitations in inbox.';
      const { formatTimeForAgent: fmtTime3 } = await import('../services/format-time.js');
      const lines = data.value.map(m => {
        const sender = m.from?.emailAddress?.name ?? m.from?.emailAddress?.address ?? 'unknown';
        return `- ${m.subject}\n  From: ${sender} (${m.from?.emailAddress?.address ?? '?'})\n  Received: ${fmtTime3(m.receivedDateTime)}\n  Message ID: ${m.id}${m.bodyPreview ? `\n  Preview: ${m.bodyPreview.slice(0, 200)}` : ''}`;
      });
      return `${data.value.length} pending calendar share invitation(s):\n\n${lines.join('\n\n')}\n\nAccept one with calendar_accept_share_ms(message_id="<id from above>").`;
    }

    case 'onedrive_list': {
      const folderId = args.folder_id as string | undefined;
      const maxResults = (args.max_results as number) ?? 20;
      const verbose = args.verbose as boolean | undefined;
      const driveId = args.drive_id as string | undefined;
      const prefix = drivePrefix(driveId);
      const endpoint = folderId
        ? `${prefix}items/${encodeURIComponent(folderId)}/children?$top=${maxResults}&$select=id,name,size,lastModifiedDateTime,file,folder,webUrl`
        : `${prefix}root/children?$top=${maxResults}&$select=id,name,size,lastModifiedDateTime,file,folder,webUrl`;

      const result = await msGraphRead(endpoint, agentId, agentName, 'onedrive_list', { folderId, maxResults, driveId });
      if (!result.ok) return `Error listing OneDrive: ${result.error}`;

      const data = result.data as { value?: Array<{ id: string; name: string; size?: number; lastModifiedDateTime: string; file?: { mimeType: string }; folder?: { childCount: number }; webUrl?: string }> };
      if (!data?.value || data.value.length === 0) return 'No files found.';

      const { formatTimeForAgent: fmtTime4 } = await import('../services/format-time.js');
      const files = data.value.map(f => {
        const size = f.size ? ` (${Math.round(f.size / 1024)}KB)` : '';
        if (verbose) {
          const type = f.folder ? `Folder (${f.folder.childCount} items)` : (f.file?.mimeType ?? 'File');
          let line = `- ${f.name}${size}\n  ID: ${f.id}\n  Type: ${type}\n  Modified: ${fmtTime4(f.lastModifiedDateTime)}`;
          if (f.webUrl) line += `\n  URL: ${f.webUrl}`;
          return line;
        }
        // Compact: one line per item. Date-only is fine in compact mode —
        // there's no time-of-day ambiguity to misread.
        const shortType = f.folder ? `folder (${f.folder.childCount})`
          : (f.file?.mimeType?.includes('word') ? 'doc'
          : f.file?.mimeType?.includes('sheet') ? 'sheet'
          : f.file?.mimeType?.includes('presentation') ? 'slides'
          : f.file?.mimeType?.includes('pdf') ? 'pdf'
          : f.file?.mimeType?.startsWith('image/') ? 'image'
          : 'file');
        return `- ${f.name}${size} [${shortType}] (${f.id}) — ${f.lastModifiedDateTime.slice(0, 10)}`;
      });

      const header = `Found ${data.value.length} item(s):\n\n${files.join(verbose ? '\n\n' : '\n')}`;
      if (verbose) return header;
      return `${header}\n\n${files.length} compact result${files.length === 1 ? '' : 's'} shown. For file content: onedrive_read(file_id=<id>). For full mime types + URLs on every result: re-call onedrive_list with verbose=true.`;
    }

    case 'onedrive_read': {
      const fileId = encodeURIComponent(args.file_id as string);
      const driveId = args.drive_id as string | undefined;
      const prefix = drivePrefix(driveId);
      // First get metadata
      const meta = await msGraphRead(
        `${prefix}items/${fileId}?$select=id,name,size,file,webUrl`,
        agentId, agentName, 'onedrive_read', { fileId: args.file_id, driveId },
      );
      if (!meta.ok) return `Error reading file: ${meta.error}`;

      const metaData = meta.data as { id: string; name: string; size?: number; file?: { mimeType: string }; webUrl?: string };

      // For text-based files, download content
      const mimeType = metaData?.file?.mimeType ?? '';
      if (mimeType.startsWith('text/') || mimeType.includes('json') || mimeType.includes('xml') || mimeType.includes('csv')) {
        try {
          const token = (await import('./auth.js')).getAccessToken();
          const resp = await fetch(`https://graph.microsoft.com/v1.0/${prefix}items/${fileId}/content`, {
            headers: { Authorization: `Bearer ${token}` },
            signal: AbortSignal.timeout(30000),
          });
          if (resp.ok) {
            const text = await resp.text();
            const { applyTextPagination } = await import('../agent/tools.js');
            const paged = applyTextPagination(
              text,
              'onedrive_read',
              { offset: args.offset as number | undefined, limit: args.limit as number | undefined },
              { file_id: args.file_id },
              16_000,
            );
            return `File: ${metaData.name}\n\n${paged}`;
          }
        } catch { /* fall through to metadata */ }
      }

      return `File: ${metaData.name}\nSize: ${metaData.size ? Math.round(metaData.size / 1024) + 'KB' : 'unknown'}\nType: ${mimeType || 'unknown'}${metaData.webUrl ? `\nURL: ${metaData.webUrl}` : ''}\n\n(Binary file — use onedrive_download_attachment or open the URL above in a browser)`;
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

        const { formatTimeForAgent: fmtTime5 } = await import('../services/format-time.js');
        const chats = data.value.map(c =>
          `- ${c.topic ?? '(untitled)'} [${c.chatType}]\n  ID: ${c.id}\n  Last updated: ${fmtTime5(c.lastUpdatedDateTime)}`
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

      const { formatTimeForAgent: fmtTime6 } = await import('../services/format-time.js');
      const messages = data.value.map(m => {
        const sender = m.from?.user?.displayName ?? 'Unknown';
        let body = m.body?.content ?? '';
        if (m.body?.contentType === 'html') body = body.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
        return `[${fmtTime6(m.createdDateTime)}] ${sender}: ${body.slice(0, 500)}`;
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
      const driveId = args.drive_id as string | undefined;
      const prefix = drivePrefix(driveId);

      const result = await msGraphRead(
        `${prefix}root/search(q='${encodeURIComponent(query)}')?$top=${maxResults}&$select=id,name,size,lastModifiedDateTime,file,folder,webUrl`,
        agentId, agentName, 'onedrive_search', { query, maxResults, driveId },
      );
      if (!result.ok) return `Error searching OneDrive: ${result.error}`;

      const data = result.data as { value?: Array<{ id: string; name: string; size?: number; lastModifiedDateTime: string; file?: { mimeType: string }; folder?: { childCount: number }; webUrl?: string }> };
      if (!data?.value || data.value.length === 0) return `No files found matching "${query}".`;

      const files = data.value.map(f => {
        const type = f.folder ? `Folder (${f.folder.childCount} items)` : (f.file?.mimeType ?? 'File');
        const size = f.size ? ` (${Math.round(f.size / 1024)}KB)` : '';
        let line = `- ${f.name}${size}\n  ID: ${f.id}\n  Type: ${type}\n  Modified: ${f.lastModifiedDateTime}`;
        if (f.webUrl) line += `\n  URL: ${f.webUrl}`;
        return line;
      });

      return `Found ${data.value.length} result(s) for "${query}":\n\n${files.join('\n\n')}`;
    }

    case 'onedrive_list_shared': {
      const max = (args.max_results as number) ?? 30;
      const result = await msGraphRead(
        `me/drive/sharedWithMe?$top=${max}&$select=id,name,size,lastModifiedDateTime,file,folder,webUrl,remoteItem`,
        agentId, agentName, 'onedrive_list_shared', { max },
      );
      if (!result.ok) return `Error listing shared files: ${result.error}`;
      const data = result.data as { value?: Array<{ id: string; name: string; size?: number; lastModifiedDateTime: string; file?: { mimeType: string }; folder?: object; webUrl?: string; remoteItem?: { id: string; parentReference?: { driveId?: string; driveType?: string } } }> };
      if (!data?.value || data.value.length === 0) return 'No files have been shared with you.';
      const lines = data.value.map(f => {
        const type = f.folder ? 'Folder' : (f.file?.mimeType ?? 'File');
        const size = f.size ? ` (${Math.round(f.size / 1024)}KB)` : '';
        const driveId = f.remoteItem?.parentReference?.driveId ?? '(unknown)';
        const itemId = f.remoteItem?.id ?? f.id;
        return `- ${f.name}${size} [${type}]\n  drive_id: ${driveId}\n  file_id: ${itemId}${f.webUrl ? `\n  URL: ${f.webUrl}` : ''}`;
      });
      return `${data.value.length} shared item(s):\n\n${lines.join('\n\n')}\n\nUse drive_id + file_id together with onedrive_read / onedrive_list / etc. to operate on a shared file.`;
    }

    case 'onedrive_list_drives': {
      const result = await msGraphRead(
        'me/drives?$select=id,name,driveType,owner',
        agentId, agentName, 'onedrive_list_drives', {},
      );
      if (!result.ok) return `Error listing drives: ${result.error}`;
      const data = result.data as { value?: Array<{ id: string; name: string; driveType: string; owner?: { user?: { displayName?: string; email?: string } } }> };
      if (!data?.value || data.value.length === 0) return 'No drives found.';
      const lines = data.value.map(d => {
        const owner = d.owner?.user?.displayName ?? d.owner?.user?.email ?? 'unknown';
        return `- ${d.name} [${d.driveType}] (owner: ${owner})\n  drive_id: ${d.id}`;
      });
      return `${data.value.length} drive(s):\n\n${lines.join('\n')}`;
    }

    case 'sharepoint_list_sites': {
      const query = args.query as string | undefined;
      const max = (args.max_results as number) ?? 20;
      const endpoint = query
        ? `sites?search=${encodeURIComponent(query)}&$top=${max}&$select=id,name,displayName,webUrl,description`
        : `sites?$top=${max}&$select=id,name,displayName,webUrl,description`;
      const result = await msGraphRead(endpoint, agentId, agentName, 'sharepoint_list_sites', { query, max });
      if (!result.ok) return `Error listing SharePoint sites: ${result.error}`;
      const data = result.data as { value?: Array<{ id: string; name: string; displayName?: string; webUrl: string; description?: string }> };
      if (!data?.value || data.value.length === 0) return query ? `No SharePoint sites matching "${query}".` : 'No SharePoint sites found.';
      const lines = data.value.map(s => {
        const name = s.displayName ?? s.name ?? '(unnamed)';
        const desc = s.description ? `\n  ${s.description.slice(0, 120)}` : '';
        return `- ${name}\n  site_id: ${s.id}\n  URL: ${s.webUrl}${desc}`;
      });
      return `${data.value.length} site(s):\n\n${lines.join('\n\n')}\n\nUse sharepoint_list_drives(site_id) to find document libraries inside a site.`;
    }

    case 'sharepoint_list_drives': {
      const siteId = args.site_id as string;
      const result = await msGraphRead(
        `sites/${encodeURIComponent(siteId)}/drives?$select=id,name,driveType,description`,
        agentId, agentName, 'sharepoint_list_drives', { siteId },
      );
      if (!result.ok) return `Error listing site drives: ${result.error}`;
      const data = result.data as { value?: Array<{ id: string; name: string; driveType: string; description?: string }> };
      if (!data?.value || data.value.length === 0) return 'No document libraries in this site.';
      const lines = data.value.map(d => {
        const desc = d.description ? `\n  ${d.description.slice(0, 120)}` : '';
        return `- ${d.name} [${d.driveType}]\n  drive_id: ${d.id}${desc}`;
      });
      return `${data.value.length} document librar${data.value.length === 1 ? 'y' : 'ies'}:\n\n${lines.join('\n')}\n\nUse drive_id with onedrive_list / onedrive_read / onedrive_upload / etc. to operate on files in a library.`;
    }

    case 'online_meeting_get': {
      const meetingId = args.meeting_id as string;
      const result = await msGraphRead(
        `me/onlineMeetings/${encodeURIComponent(meetingId)}?$select=id,subject,joinUrl,joinWebUrl,startDateTime,endDateTime,videoTeleconferenceId`,
        agentId, agentName, 'online_meeting_get', { meetingId },
      );
      if (!result.ok) return `Error getting online meeting: ${result.error}`;
      const m = result.data as { id: string; subject?: string; joinUrl?: string; joinWebUrl?: string; startDateTime?: string; endDateTime?: string; videoTeleconferenceId?: string };
      const lines = [
        `Online meeting: ${m.subject ?? '(no subject)'}`,
        `ID: ${m.id}`,
      ];
      if (m.startDateTime) lines.push(`Start: ${m.startDateTime}`);
      if (m.endDateTime) lines.push(`End: ${m.endDateTime}`);
      if (m.joinUrl) lines.push(`Join URL: ${m.joinUrl}`);
      if (m.joinWebUrl && m.joinWebUrl !== m.joinUrl) lines.push(`Web URL: ${m.joinWebUrl}`);
      if (m.videoTeleconferenceId) lines.push(`VTC dial-in ID: ${m.videoTeleconferenceId}`);
      return lines.join('\n');
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
