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
    name: 'teams_list_attachments',
    description: 'List attachments on a Microsoft Teams chat message — name, contentType, and attachment ID for each. Requires a Microsoft work/school account (Entra ID). Use teams_download_attachment with one of these IDs to save to local disk.',
    input_schema: {
      type: 'object',
      properties: {
        chat_id: { type: 'string', description: 'Teams chat ID (from teams_list_chats)' },
        message_id: { type: 'string', description: 'Teams message ID (from teams_read_messages)' },
      },
      required: ['chat_id', 'message_id'],
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
  // ── Microsoft To Do (Tasks) ──
  {
    name: 'tasks_list_lists',
    description: 'List all of the user\'s Microsoft To Do task lists. Returns each list\'s ID, display name, and whether it\'s the default list. Most users have a single default list (often called "Tasks") plus any extra lists they created (e.g., "Groceries", "Work").',
    input_schema: { type: 'object', properties: {}, required: [] },
    concurrency: 'safe',
    maxResultTokens: 1500,
  },
  {
    name: 'tasks_list',
    description: 'List tasks in a Microsoft To Do list. Defaults to the user\'s primary "Tasks" list; pass list_id to target a specific list (get IDs from tasks_list_lists). Filter by status to focus the result (e.g., status="notStarted" to see open tasks only).',
    input_schema: {
      type: 'object',
      properties: {
        list_id: { type: 'string', description: 'Task list ID (from tasks_list_lists). Omit to use the default list.' },
        status: { type: 'string', enum: ['notStarted', 'inProgress', 'completed', 'waitingOnOthers', 'deferred'], description: 'Optional status filter. Omit to show all tasks regardless of status.' },
        max_results: { type: 'number', description: 'Maximum tasks to return (default: 25, max: 100).' },
      },
      required: [],
    },
    concurrency: 'safe',
    maxResultTokens: 3000,
  },
  // ── Teams / Online Meetings discovery ──
  {
    name: 'teams_list_chats',
    description: 'List the user\'s Teams chats (1:1 and group). Returns each chat\'s display name (or member list), chat ID, and chat type. Use this to discover chats BEFORE teams_send_message - cleaner than calling teams_read_messages without a chat_id (which works as a workaround but reads weird).',
    input_schema: {
      type: 'object',
      properties: {
        max_results: { type: 'number', description: 'Maximum chats to return (default: 25, max: 50).' },
      },
      required: [],
    },
    concurrency: 'safe',
    maxResultTokens: 2000,
  },
  {
    name: 'online_meeting_list',
    description: 'List the user\'s upcoming Teams online meetings (next 7 days by default). Useful when the agent needs to find an existing meeting to share or update. For one-off lookup by ID, use online_meeting_get.',
    input_schema: {
      type: 'object',
      properties: {
        days_ahead: { type: 'number', description: 'How far ahead to search in days (default: 7).' },
      },
      required: [],
    },
    concurrency: 'safe',
    maxResultTokens: 2000,
  },
  // ── OneDrive version history ──
  {
    name: 'onedrive_versions_list',
    description: 'List the version history of a OneDrive file. OneDrive auto-versions on every edit and keeps versions indefinitely (subject to admin policy). Returns each version\'s ID, modified time, size, and who modified it.',
    input_schema: {
      type: 'object',
      properties: {
        file_id: { type: 'string', description: 'OneDrive item (file) ID.' },
      },
      required: ['file_id'],
    },
    concurrency: 'safe',
    maxResultTokens: 2000,
  },
  // ── Calendar free/busy ──
  {
    name: 'calendar_freebusy_ms',
    description: 'Check free/busy availability for one or more people across Microsoft Calendars over a time window. Returns busy time blocks per attendee so you can pick a slot when everyone is free. Use this BEFORE proposing a meeting time - much cheaper than calendar_create_ms + retry on conflicts.',
    input_schema: {
      type: 'object',
      properties: {
        attendees: { type: 'array', items: { type: 'string' }, description: 'Email addresses to check (include the user themselves if you want their schedule too).' },
        start: { type: 'string', description: "Window start datetime (ISO 8601, e.g., '2026-05-30T08:00:00')." },
        end: { type: 'string', description: 'Window end datetime (ISO 8601).' },
        interval_minutes: { type: 'number', description: 'Granularity of the availability view in minutes (default: 30).' },
      },
      required: ['attendees', 'start', 'end'],
    },
    concurrency: 'safe',
    maxResultTokens: 3000,
  },
  // ── Outlook mail folders ──
  {
    name: 'outlook_list_folders',
    description: 'List all of the user\'s Outlook mail folders (Inbox, Sent Items, Drafts, plus any custom folders the user created). Returns each folder\'s display name, ID, total message count, and unread count. Use this before outlook_move_to_folder so you target an actual folder.',
    input_schema: { type: 'object', properties: {}, required: [] },
    concurrency: 'safe',
    maxResultTokens: 1500,
  },
  // ── Microsoft Contacts (People in the user's address book) ──
  {
    name: 'contacts_search',
    description: 'Search the user\'s Microsoft contacts (Outlook address book) by name, email, company, job title, or notes. Returns each match\'s display name, primary email, primary phone, company, and contact ID.',
    input_schema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: "Search string (matches name, email, company, job title, notes). E.g., 'Alex', 'acme.com', 'CFO'." },
        max_results: { type: 'number', description: 'Maximum results to return (default: 20, max: 100).' },
      },
      required: ['query'],
    },
    concurrency: 'safe',
    maxResultTokens: 2500,
  },
  {
    name: 'contacts_list',
    description: 'List the user\'s Microsoft contacts, newest-first. Useful when you don\'t have a specific search term. For lookup by name/email/company, prefer contacts_search.',
    input_schema: {
      type: 'object',
      properties: {
        max_results: { type: 'number', description: 'Maximum contacts to return (default: 25, max: 100).' },
      },
      required: [],
    },
    concurrency: 'safe',
    maxResultTokens: 3000,
  },
  {
    name: 'contacts_get',
    description: 'Get the full record for a single Microsoft contact by ID. Returns all fields the user has set: every email, every phone, addresses, birthday, notes, categories.',
    input_schema: {
      type: 'object',
      properties: {
        contact_id: { type: 'string', description: 'Contact ID (from contacts_search or contacts_list).' },
      },
      required: ['contact_id'],
    },
    concurrency: 'safe',
    maxResultTokens: 2000,
  },
  // ── Microsoft OneNote (notebooks > sections > pages) ──
  {
    name: 'onenote_list_notebooks',
    description: 'List all of the user\'s OneNote notebooks. Returns each notebook\'s display name, ID, and whether it is the default notebook. OneNote organizes content as notebooks > sections > pages; start here to discover what notebooks exist, then onenote_list_sections to drill in.',
    input_schema: { type: 'object', properties: {}, required: [] },
    concurrency: 'safe',
    maxResultTokens: 1500,
  },
  {
    name: 'onenote_list_sections',
    description: 'List sections in a OneNote notebook. Pass notebook_id (from onenote_list_notebooks). Returns each section\'s display name and ID. Sections contain pages.',
    input_schema: {
      type: 'object',
      properties: {
        notebook_id: { type: 'string', description: 'Notebook ID (from onenote_list_notebooks).' },
      },
      required: ['notebook_id'],
    },
    concurrency: 'safe',
    maxResultTokens: 2000,
  },
  {
    name: 'onenote_list_pages',
    description: 'List pages in a OneNote section. Pass section_id (from onenote_list_sections). Returns each page\'s title, ID, and last-modified timestamp, newest-first. Use onenote_read_page to fetch full content.',
    input_schema: {
      type: 'object',
      properties: {
        section_id: { type: 'string', description: 'Section ID (from onenote_list_sections).' },
        max_results: { type: 'number', description: 'Maximum pages to return (default: 25, max: 100).' },
      },
      required: ['section_id'],
    },
    concurrency: 'safe',
    maxResultTokens: 2500,
  },
  {
    name: 'onenote_read_page',
    description: 'Read the full HTML content of a OneNote page by ID. OneNote stores pages as HTML; the response is plain HTML with text content visible inside tags. For long pages, the result may be paginated by character offset.',
    input_schema: {
      type: 'object',
      properties: {
        page_id: { type: 'string', description: 'Page ID (from onenote_list_pages).' },
        offset: { type: 'number', description: 'Character offset for pagination (default: 0).' },
        limit: { type: 'number', description: 'Max characters to return (default: 16000).' },
      },
      required: ['page_id'],
    },
    concurrency: 'safe',
    maxResultTokens: 4000,
  },
];

// Phase 3.5 (2026-05-04) — register concurrency + maxResultTokens overrides
// v2.7.0 multi-account: user_* tool variants. Same shape as the Google
// generator in tools-read.ts — for each canonical tool name, emit a
// `user_*` counterpart wired to the User slot. Always emitted so static
// importers (agent/tools.ts) get the full surface at startup.
// Full-parity (2026-06-17): every Microsoft read tool gets a user-slot
// variant. Every read case threads the resolved `slot` into msGraphRead
// (compiler-verified), so the variant reads the user's account and is gated
// by isMsToolEnabledByService (User slot connected AND service enabled).
// Snapshot the base list first so we don't iterate over appended variants.
const microsoftReadBaseTools = [...microsoftReadToolDefinitions];
for (const baseDef of microsoftReadBaseTools) {
  const canonical = baseDef.name;
  microsoftReadToolDefinitions.push({
    ...baseDef,
    name: `user_${canonical}`,
    description: `[USER'S Microsoft account variant of \`${canonical}\`] ${baseDef.description}\n\nThis variant reads from the user's connected Microsoft account (configured in Settings → Microsoft as the User slot). The agent's own account is read by the unprefixed \`${canonical}\` tool. If the user has not connected a User account, this tool returns a friendly error pointing them at Settings.`,
  });
}

// with the v2 partitioner / cap registry. tools.ts imports this module
// statically, so registration happens at app startup.
import { registerConcurrency, registerMaxResultTokens } from '../agent/v2/classifiers/concurrency.js';
for (const def of microsoftReadToolDefinitions) {
  if (def.concurrency) registerConcurrency(def.name, def.concurrency);
  if (def.maxResultTokens) registerMaxResultTokens(def.name, def.maxResultTokens);
}

// Path B (multi-account): every Microsoft read tool can target a specific
// connected account of its kind via an `account` param (the account's email).
for (const def of microsoftReadToolDefinitions) {
  const schema = def.input_schema as { properties?: Record<string, unknown> };
  if (schema.properties && !schema.properties.account) {
    schema.properties.account = {
      type: 'string',
      description: "Which connected account to act on, by its email address. Omit to use the only connected account of this type; required when more than one is connected.",
    };
  }
}

// ── Tool Execution ──

const microsoftReadToolDefByName = new Map(microsoftReadToolDefinitions.map(t => [t.name, t]));

// ════════════════════════════════════════
// F4: shared per-account FETCH helpers (mirror google/tools-read.ts).
//
// The narrow `calendar_agenda_ms` / `outlook_search` cases and the merged
// tools/unified-read.ts executors both call these — one fetch path, two
// renderers. Structured items out; the narrow-case rendering downstream stays
// byte-for-byte what it was. Import direction is one-way (unified-read -> here).
// ════════════════════════════════════════

/** Normalized calendar event, provider-agnostic once times are parsed to Dates. */
export interface MsAgendaFetchItem {
  title: string;
  start: Date | null;
  end: Date | null;
  rawStart: string;
  rawEnd: string;
  allDay: boolean;
  location?: string;
  notes?: string;
  id?: string;
}

/** Normalized email row (metadata only) for search rendering. */
export interface MsMailFetchItem {
  id: string;
  from: string;
  to: string;
  subject: string;
  dateDisplay: string;
  dateSortMs: number;
  snippet: string;
  /** Raw Graph isRead flag (see outlook_search: its label expression is inverted; unified uses this correctly). */
  read: boolean | undefined;
}

/** Fetch + normalize one account's events for a window. `accountId` is the row id (slot). */
export async function fetchAgendaItemsForAccountMs(
  accountId: string,
  window: { startISO: string; endISO: string; anchored: boolean },
  agentId: string,
  agentName: string,
  opts?: { calendarId?: string; days?: number },
): Promise<{ ok: true; items: MsAgendaFetchItem[] } | { ok: false; error: string }> {
  const calendarId = opts?.calendarId;
  const result = await msGraphRead(
    `${calendarPrefix(calendarId)}calendarView?startDateTime=${window.startISO}&endDateTime=${window.endISO}&$orderby=start/dateTime&$select=id,subject,start,end,location,bodyPreview,isAllDay`,
    agentId, agentName, 'calendar_agenda_ms', { days: opts?.days, calendarId, anchored: window.anchored }, accountId,
  );
  if (!result.ok) return { ok: false, error: result.error ?? 'unknown error' };

  const data = result.data as { value?: Array<{ id: string; subject: string; start: { dateTime: string; timeZone?: string }; end: { dateTime: string; timeZone?: string }; location?: { displayName?: string }; bodyPreview?: string; isAllDay?: boolean }> };
  // Microsoft Graph returns start/end as naked ISO with no offset; the timeZone
  // field on each side tells us how to interpret it (defaults to UTC). Parse
  // here so both renderers get real Dates.
  const { parseFlexibleTime } = await import('../services/format-time.js');
  const items: MsAgendaFetchItem[] = (data?.value ?? []).map(e => {
    const startTz = e.start.timeZone || 'UTC';
    const endTz = e.end.timeZone || 'UTC';
    return {
      title: e.subject,
      start: parseFlexibleTime(e.start.dateTime, startTz),
      end: parseFlexibleTime(e.end.dateTime, endTz),
      rawStart: e.start.dateTime,
      rawEnd: e.end.dateTime,
      allDay: e.isAllDay === true,
      location: e.location?.displayName,
      notes: e.bodyPreview,
      id: e.id,
    };
  });
  return { ok: true, items };
}

/** Search one account's Outlook mail. */
export async function searchMailForAccountMs(
  accountId: string,
  query: string,
  maxResults: number,
  agentId: string,
  agentName: string,
): Promise<{ ok: true; items: MsMailFetchItem[] } | { ok: false; error: string }> {
  const result = await msGraphRead(
    `me/messages?$search="${encodeURIComponent(query)}"&$top=${maxResults}&$select=id,from,subject,receivedDateTime,bodyPreview,isRead`,
    agentId, agentName, 'outlook_search', { query, maxResults }, accountId,
  );
  if (!result.ok) return { ok: false, error: result.error ?? 'unknown error' };

  const data = result.data as { value?: Array<{ id: string; from: { emailAddress: { name: string; address: string } }; subject: string; receivedDateTime: string; bodyPreview: string; isRead: boolean }> };
  const { formatTimeForAgent } = await import('../services/format-time.js');
  const items: MsMailFetchItem[] = (data?.value ?? []).map(m => {
    const fromName = m.from?.emailAddress?.name ?? '';
    const fromAddr = m.from?.emailAddress?.address ?? '';
    return {
      id: m.id,
      from: `${fromName} <${fromAddr}>`,
      to: '',
      subject: m.subject,
      dateDisplay: formatTimeForAgent(m.receivedDateTime),
      dateSortMs: new Date(m.receivedDateTime).getTime() || 0,
      snippet: m.bodyPreview,
      read: m.isRead,
    };
  });
  return { ok: true, items };
}

// F4 data floor: the narrow read cases below no longer nudge with an advice
// note (a weak model ignored it and answered from one surface). They now append
// the ACTUAL other-surface data via otherCalendarsAgendaSection /
// otherMailboxesCountSection (tools/unified-read.ts). The requirement the old
// unifiedCoverageNote encoded — a narrow result must never read as the whole
// picture — is preserved, strictly better, by carrying the data itself.

export async function executeMicrosoftReadTool(
  name: string,
  args: Record<string, unknown>,
  agentId: string,
  agentName: string,
): Promise<string> {
  // The user_ prefix selects the KIND; the `account` param selects which of
  // that kind's connected accounts. `slot` carries the resolved account id,
  // threaded into msGraphRead/Write.
  let kind: import('./auth.js').AccountSlot = 'agent';
  let canonicalName = name;
  if (name.startsWith('user_')) {
    kind = 'user';
    canonicalName = name.slice('user_'.length);
  }

  // Schema-driven required-field validation. Same approach as Slides — keeps
  // validation co-located with the tool definitions.
  const { validateAgainstSchema } = await import('../agent/tool-helpers.js');
  const def = microsoftReadToolDefByName.get(canonicalName);
  const schemaErr = validateAgainstSchema(canonicalName, def?.input_schema as Parameters<typeof validateAgainstSchema>[1], args);
  if (schemaErr) return schemaErr;

  const { resolveMicrosoftAccountForTool } = await import('./accounts.js');
  const resolved = resolveMicrosoftAccountForTool(kind, args.account as string | undefined);
  if ('error' in resolved) return `Error: ${resolved.error}`;
  const slot = resolved.account.id;

  switch (canonicalName) {
    case 'outlook_search': {
      const query = args.query as string;
      const maxResults = (args.max_results as number) ?? 10;
      const verbose = args.verbose as boolean | undefined;

      const fetched = await searchMailForAccountMs(slot, query, maxResults, agentId, agentName);
      if (!fetched.ok) return `Error searching Outlook: ${fetched.error}`;

      // F4 data floor: the SAME query run against every OTHER connected mailbox,
      // counts only, so a single-mailbox search never reads as the whole picture.
      const { otherMailboxesCountSection } = await import('../tools/unified-read.js');
      const others = await otherMailboxesCountSection({ provider: 'microsoft', accountId: slot }, query, 0, agentId, agentName);

      if (fetched.items.length === 0) return 'No emails found matching that query.' + others;

      const emails = fetched.items.map(m => {
        // Tag UNREAD mail (pre-existing inversion labeled READ mail instead;
        // fixed 2026-07-07, outlook_inbox and the merged email_search already
        // had the correct sense).
        const unread = m.read ? '' : ' [UNREAD]';
        if (verbose) {
          return `${unread.trim()}ID: ${m.id}\nFrom: ${m.from}\nSubject: ${m.subject}\nDate: ${m.dateDisplay}\nPreview: ${m.snippet}`;
        }
        // Compact: one line per email — drop preview body, keep date+sender+subject+unread.
        return `-${unread} ${m.dateDisplay} | ${m.from} — ${m.subject}\n  ID: ${m.id}`;
      });

      const header = `Found ${fetched.items.length} email(s):\n\n${emails.join(verbose ? '\n\n---\n\n' : '\n')}`;
      if (verbose) return header + others;
      return `${header}\n\n${emails.length} compact result${emails.length === 1 ? '' : 's'} shown. For full body of one: outlook_read(message_id=<id>). For previews on every result: re-call outlook_search with verbose=true.${others}`;
    }

    case 'outlook_read': {
      const messageId = encodeURIComponent(args.message_id as string);
      const result = await msGraphRead(
        `me/messages/${messageId}?$select=id,from,toRecipients,ccRecipients,subject,receivedDateTime,body,hasAttachments`,
        agentId, agentName, 'outlook_read', { messageId: args.message_id }, slot,
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
        agentId, agentName, 'outlook_inbox', { maxResults, unreadOnly }, slot,
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

      const fetched = await fetchAgendaItemsForAccountMs(slot, window, agentId, agentName, { calendarId, days });
      if (!fetched.ok) return `Error fetching calendar: ${fetched.error}`;

      // F4 data floor: the SAME window fetched from every OTHER connected
      // calendar surface, compact + labeled, so a single-calendar agenda never
      // reads as the whole day (advice notes were ignored by the floor model).
      const tz = requestedTz ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
      const { otherCalendarsAgendaSection } = await import('../tools/unified-read.js');
      const others = await otherCalendarsAgendaSection({ provider: 'microsoft', accountId: slot }, window, tz, days, agentId, agentName);

      if (fetched.items.length === 0) return `No events in the next ${days} day(s).` + others;

      // Times are already parsed to Dates by the helper (Graph gives naked ISO +
      // a per-side timeZone). formatTimeRangeForAgent renders an unambiguous
      // dual-format string so the agent doesn't misread the ISO as local time.
      const { formatTimeRangeForAgent } = await import('../services/format-time.js');
      const events = fetched.items.map(e => {
        const when = e.start && e.end
          ? formatTimeRangeForAgent(e.start, e.end, { timezone: requestedTz, allDay: e.allDay })
          : `${e.rawStart} to ${e.rawEnd} (could not parse)`;
        let line = `- ${e.title}\n  ${when}`;
        if (e.location) line += `\n  Location: ${e.location}`;
        if (e.notes) line += `\n  Notes: ${e.notes.slice(0, 200)}`;
        line += `\n  ID: ${e.id}`;
        return line;
      });

      return `Calendar agenda (next ${days} day(s)):\n\n${events.join('\n\n')}` + others;
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
      slot);
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
        agentId, agentName, 'calendar_list_ms', {}, slot,
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
        agentId, agentName, 'calendar_share_invites_ms', { max }, slot,
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

      const result = await msGraphRead(endpoint, agentId, agentName, 'onedrive_list', { folderId, maxResults, driveId }, slot);
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
        agentId, agentName, 'onedrive_read', { fileId: args.file_id, driveId }, slot,
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
          agentId, agentName, 'teams_list_chats', {}, slot,
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
        agentId, agentName, 'teams_read_messages', { chatId, maxResults }, slot,
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

    case 'teams_list_attachments': {
      const chatId = args.chat_id as string;
      const messageId = args.message_id as string;
      // Teams message attachments live on the message body, not at a
      // separate /attachments collection like Outlook. Fetch the
      // message and surface its attachments array.
      const result = await msGraphRead(
        `chats/${encodeURIComponent(chatId)}/messages/${encodeURIComponent(messageId)}?$select=id,attachments`,
        agentId, agentName, 'teams_list_attachments', { chatId, messageId }, slot,
      );
      if (!result.ok) return `Error listing Teams attachments: ${result.error}`;
      const data = result.data as {
        attachments?: Array<{ id: string; name?: string; contentType?: string; contentUrl?: string }>;
      };
      const atts = data?.attachments ?? [];
      if (atts.length === 0) return 'No attachments on this Teams message.';
      const items = atts.map(a =>
        `- ${a.name ?? '(unnamed)'} (${a.contentType ?? 'unknown type'})\n  ID: ${a.id}`,
      );
      return `Attachments (${atts.length}):\n\n${items.join('\n\n')}\n\nUse teams_download_attachment with the chat_id, message_id, and attachment_id to save to local disk.`;
    }

    case 'outlook_list_attachments': {
      const messageId = encodeURIComponent(args.message_id as string);
      const result = await msGraphRead(
        `me/messages/${messageId}/attachments?$select=id,name,contentType,size,isInline`,
        agentId, agentName, 'outlook_list_attachments', { messageId: args.message_id }, slot,
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
      slot);
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
        agentId, agentName, 'onedrive_list_shared', { max }, slot,
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
        agentId, agentName, 'onedrive_list_drives', {}, slot,
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
      const result = await msGraphRead(endpoint, agentId, agentName, 'sharepoint_list_sites', { query, max }, slot);
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
        agentId, agentName, 'sharepoint_list_drives', { siteId }, slot,
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
        agentId, agentName, 'online_meeting_get', { meetingId }, slot,
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
        agentId, agentName, 'teams_list_teams', {}, slot,
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
        agentId, agentName, 'teams_list_channels', { teamId: args.team_id }, slot,
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
        agentId, agentName, 'teams_read_channel_messages', { teamId: args.team_id, channelId: args.channel_id, maxResults }, slot,
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

    case 'teams_list_chats': {
      const maxResults = Math.min((args.max_results as number) ?? 25, 50);
      const result = await msGraphRead(
        `me/chats?$top=${maxResults}&$expand=members&$orderby=${encodeURIComponent('lastUpdatedDateTime desc')}`,
        agentId, agentName, 'teams_list_chats', { maxResults }, slot,
      );
      if (!result.ok) return `Error listing chats: ${result.error}`;
      const data = result.data as { value?: Array<{ id: string; chatType: string; topic?: string; lastUpdatedDateTime?: string; members?: Array<{ displayName?: string }> }> };
      const chats = data?.value ?? [];
      if (chats.length === 0) return 'No Teams chats found. Use teams_create_chat to start one.';
      const { formatTimeForAgent } = await import('../services/format-time.js');
      const lines = chats.map(c => {
        const label = c.topic
          ? `"${c.topic}"`
          : (c.members ?? []).map(m => m.displayName).filter(Boolean).join(', ') || '(no members visible)';
        const when = c.lastUpdatedDateTime ? ` | last activity ${formatTimeForAgent(c.lastUpdatedDateTime)}` : '';
        return `- [${c.chatType}] ${label}${when}\n    ID: ${c.id}`;
      });
      return `${chats.length} chat(s):\n\n${lines.join('\n')}\n\nUse teams_send_message(chat_id, message) to send to one.`;
    }

    case 'online_meeting_list': {
      const days = (args.days_ahead as number) ?? 7;
      const now = new Date();
      const future = new Date(now.getTime() + days * 24 * 60 * 60 * 1000);
      const filter = encodeURIComponent(`startDateTime ge ${now.toISOString()} and startDateTime le ${future.toISOString()}`);
      const result = await msGraphRead(
        `me/onlineMeetings?$filter=${filter}&$select=id,subject,startDateTime,endDateTime,joinUrl,joinWebUrl`,
        agentId, agentName, 'online_meeting_list', { daysAhead: days }, slot,
      );
      if (!result.ok) return `Error listing online meetings: ${result.error}`;
      const data = result.data as { value?: Array<{ id: string; subject: string; startDateTime: string; endDateTime: string; joinUrl?: string }> };
      const meetings = data?.value ?? [];
      if (meetings.length === 0) return `No online meetings scheduled in the next ${days} day(s).`;
      const { formatTimeForAgent } = await import('../services/format-time.js');
      const lines = meetings.map(m => {
        const join = m.joinUrl ? `\n    Join: ${m.joinUrl}` : '';
        return `- "${m.subject}" | ${formatTimeForAgent(m.startDateTime)} → ${formatTimeForAgent(m.endDateTime)}\n    ID: ${m.id}${join}`;
      });
      return `${meetings.length} online meeting(s) in the next ${days} day(s):\n\n${lines.join('\n')}`;
    }

    case 'onedrive_versions_list': {
      const fileId = encodeURIComponent(args.file_id as string);
      const result = await msGraphRead(
        `me/drive/items/${fileId}/versions?$select=id,size,lastModifiedDateTime,lastModifiedBy`,
        agentId, agentName, 'onedrive_versions_list', { fileId: args.file_id }, slot,
      );
      if (!result.ok) return `Error listing versions: ${result.error}`;
      const data = result.data as { value?: Array<{ id: string; size: number; lastModifiedDateTime: string; lastModifiedBy?: { user?: { displayName?: string } } }> };
      const versions = data?.value ?? [];
      if (versions.length === 0) return 'No version history available for this file.';
      const { formatTimeForAgent } = await import('../services/format-time.js');
      const lines = versions.map(v => {
        const who = v.lastModifiedBy?.user?.displayName ? ` by ${v.lastModifiedBy.user.displayName}` : '';
        return `- ${formatTimeForAgent(v.lastModifiedDateTime)}${who} | ${Math.round(v.size / 1024)}KB\n    ID: ${v.id}`;
      });
      return `${versions.length} version(s):\n\n${lines.join('\n')}\n\nUse onedrive_versions_restore(file_id, version_id) to restore an old version (current version is also kept).`;
    }

    case 'calendar_freebusy_ms': {
      const attendees = args.attendees as string[];
      const start = args.start as string;
      const end = args.end as string;
      const interval = (args.interval_minutes as number) ?? 30;
      const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
      // getSchedule is a POST that returns availability views. Use raw fetch
      // because msGraphRead is GET-only.
      const token = await (await import('./auth.js')).getValidAccessTokenForAccount(slot);
      if (!token) return 'Error: not authenticated with Microsoft.';
      try {
        const resp = await fetch('https://graph.microsoft.com/v1.0/me/calendar/getSchedule', {
          method: 'POST',
          headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            schedules: attendees,
            startTime: { dateTime: start, timeZone: tz },
            endTime: { dateTime: end, timeZone: tz },
            availabilityViewInterval: interval,
          }),
          signal: AbortSignal.timeout(30_000),
        });
        if (!resp.ok) {
          const errText = await resp.text();
          return `Error checking free/busy: ${errText.slice(0, 300)}`;
        }
        const data = await resp.json() as { value?: Array<{ scheduleId: string; availabilityView?: string; scheduleItems?: Array<{ start: { dateTime: string }; end: { dateTime: string }; status: string; subject?: string }>; error?: { responseCode: string; message: string } }> };
        const results = data?.value ?? [];
        const { formatTimeForAgent } = await import('../services/format-time.js');
        const lines: string[] = [`Free/busy for ${start} to ${end} (${interval}min granularity):`];
        for (const r of results) {
          if (r.error) {
            lines.push(`\n${r.scheduleId}: ERROR - ${r.error.message} (${r.error.responseCode})`);
            continue;
          }
          const items = r.scheduleItems ?? [];
          if (items.length === 0) {
            lines.push(`\n${r.scheduleId}: FREE the entire window.`);
          } else {
            lines.push(`\n${r.scheduleId}: ${items.length} item(s):`);
            items.forEach(it => {
              const subj = it.subject ? ` "${it.subject}"` : '';
              lines.push(`  [${it.status}] ${formatTimeForAgent(it.start.dateTime)} → ${formatTimeForAgent(it.end.dateTime)}${subj}`);
            });
          }
          // The availabilityView string is a per-slot encoding: 0=free, 1=tentative, 2=busy, 3=oof, 4=workingElsewhere. Useful as a visual.
          if (r.availabilityView) {
            lines.push(`  view: ${r.availabilityView}  (0=free 1=tentative 2=busy 3=outOfOffice 4=workingElsewhere)`);
          }
        }
        return lines.join('\n');
      } catch (err) {
        return `Error checking free/busy: ${err instanceof Error ? err.message : String(err)}`;
      }
    }

    case 'outlook_list_folders': {
      // Top-level mail folders (no recursion into child folders by default;
      // most users keep folders flat). Pass $expand to surface child counts.
      const result = await msGraphRead(
        'me/mailFolders?$top=100&$select=id,displayName,totalItemCount,unreadItemCount,childFolderCount',
        agentId, agentName, 'outlook_list_folders', {}, slot,
      );
      if (!result.ok) return `Error listing folders: ${result.error}`;
      const data = result.data as { value?: Array<{ id: string; displayName: string; totalItemCount: number; unreadItemCount: number; childFolderCount?: number }> };
      const folders = data?.value ?? [];
      if (folders.length === 0) return 'No mail folders found.';
      const lines = folders.map(f => {
        const unread = f.unreadItemCount > 0 ? ` | ${f.unreadItemCount} unread` : '';
        const children = (f.childFolderCount ?? 0) > 0 ? ` | ${f.childFolderCount} subfolder(s)` : '';
        return `- ${f.displayName} (${f.totalItemCount} items${unread}${children})\n    ID: ${f.id}`;
      });
      return `${folders.length} mail folder(s):\n\n${lines.join('\n')}\n\nUse outlook_move_to_folder(message_id, folder_id) to move email.`;
    }

    case 'tasks_list_lists': {
      const result = await msGraphRead(
        'me/todo/lists',
        agentId, agentName, 'tasks_list_lists', {}, slot,
      );
      if (!result.ok) return `Error listing task lists: ${result.error}`;
      const data = result.data as { value?: Array<{ id: string; displayName: string; wellknownListName?: string; isOwner?: boolean; isShared?: boolean }> };
      const lists = data?.value ?? [];
      if (lists.length === 0) return 'No task lists found. The default list is created automatically the first time you use Microsoft To Do.';
      const lines = lists.map(l => {
        const tags: string[] = [];
        if (l.wellknownListName === 'defaultList') tags.push('DEFAULT');
        if (l.isShared) tags.push('shared');
        if (l.isOwner === false) tags.push('not-owner');
        const tagStr = tags.length > 0 ? ` [${tags.join(', ')}]` : '';
        return `- ${l.displayName}${tagStr}\n    ID: ${l.id}`;
      });
      return `${lists.length} task list(s):\n\n${lines.join('\n')}\n\nUse the list ID with tasks_list to see its contents.`;
    }

    case 'tasks_list': {
      // Resolve list_id: use provided one, else find the well-known default list.
      let listId = args.list_id as string | undefined;
      if (!listId) {
        const lookupUrl = "me/todo/lists?$filter=wellknownListName eq 'defaultList'&$top=1";
        const lookup = await msGraphRead(lookupUrl, agentId, agentName, 'tasks_list:default-lookup', {}, slot);
        if (!lookup.ok) return `Error resolving default task list: ${lookup.error}`;
        const lookupData = lookup.data as { value?: Array<{ id: string }> };
        listId = lookupData?.value?.[0]?.id;
        if (!listId) return 'No default task list found. Call tasks_list_lists to see what lists exist and pass list_id explicitly.';
      }
      const maxResults = Math.min((args.max_results as number) ?? 25, 100);
      const status = args.status as string | undefined;
      const params: string[] = [`$top=${maxResults}`];
      if (status) params.push(`$filter=${encodeURIComponent(`status eq '${status}'`)}`);
      params.push('$orderby=' + encodeURIComponent('lastModifiedDateTime desc'));
      const url = `me/todo/lists/${encodeURIComponent(listId)}/tasks?${params.join('&')}`;
      const result = await msGraphRead(url, agentId, agentName, 'tasks_list', { listId, status, maxResults }, slot);
      if (!result.ok) return `Error listing tasks: ${result.error}`;
      const data = result.data as { value?: Array<{ id: string; title: string; status: string; importance?: string; dueDateTime?: { dateTime: string; timeZone: string }; body?: { content: string; contentType: string }; completedDateTime?: { dateTime: string } }> };
      const tasks = data?.value ?? [];
      if (tasks.length === 0) return status ? `No tasks with status="${status}" in this list.` : 'No tasks in this list.';

      const { formatTimeForAgent } = await import('../services/format-time.js');
      const lines = tasks.map(t => {
        const flags: string[] = [t.status];
        if (t.importance && t.importance !== 'normal') flags.push(`${t.importance} priority`);
        const dueStr = t.dueDateTime?.dateTime ? ` | due ${formatTimeForAgent(t.dueDateTime.dateTime)}` : '';
        const completedStr = t.completedDateTime?.dateTime ? ` | done ${formatTimeForAgent(t.completedDateTime.dateTime)}` : '';
        const bodyPreview = t.body?.content
          ? ` — ${t.body.content.replace(/\s+/g, ' ').trim().slice(0, 120)}${t.body.content.length > 120 ? '…' : ''}`
          : '';
        return `- [${flags.join(' | ')}] ${t.title}${dueStr}${completedStr}${bodyPreview}\n    ID: ${t.id}`;
      });
      const header = status ? `${tasks.length} ${status} task(s):` : `${tasks.length} task(s):`;
      return `${header}\n\n${lines.join('\n')}`;
    }

    case 'contacts_search': {
      const query = args.query as string;
      const maxResults = Math.min((args.max_results as number) ?? 20, 100);
      const url = `me/contacts?$search="${encodeURIComponent(query)}"&$top=${maxResults}&$select=id,displayName,givenName,surname,emailAddresses,mobilePhone,businessPhones,homePhones,companyName,jobTitle`;
      const result = await msGraphRead(url, agentId, agentName, 'contacts_search', { query, maxResults }, slot);
      if (!result.ok) return `Error searching contacts: ${result.error}`;
      const data = result.data as { value?: Array<MicrosoftContact> };
      const contacts = data?.value ?? [];
      if (contacts.length === 0) return `No contacts matched "${query}".`;
      return `${contacts.length} contact(s) matching "${query}":\n\n${contacts.map(formatContactLine).join('\n')}\n\nUse contacts_get(contact_id) for the full record.`;
    }

    case 'contacts_list': {
      const maxResults = Math.min((args.max_results as number) ?? 25, 100);
      const url = `me/contacts?$top=${maxResults}&$orderby=${encodeURIComponent('lastModifiedDateTime desc')}&$select=id,displayName,givenName,surname,emailAddresses,mobilePhone,businessPhones,homePhones,companyName,jobTitle`;
      const result = await msGraphRead(url, agentId, agentName, 'contacts_list', { maxResults }, slot);
      if (!result.ok) return `Error listing contacts: ${result.error}`;
      const data = result.data as { value?: Array<MicrosoftContact> };
      const contacts = data?.value ?? [];
      if (contacts.length === 0) return 'No contacts found in your Microsoft address book.';
      return `${contacts.length} contact(s):\n\n${contacts.map(formatContactLine).join('\n')}\n\nUse contacts_get(contact_id) for the full record, or contacts_search(query) for a targeted lookup.`;
    }

    case 'contacts_get': {
      const contactId = encodeURIComponent(args.contact_id as string);
      const result = await msGraphRead(`me/contacts/${contactId}`, agentId, agentName, 'contacts_get', { contactId: args.contact_id }, slot);
      if (!result.ok) return `Error fetching contact: ${result.error}`;
      const c = result.data as MicrosoftContact & { birthday?: string; personalNotes?: string; businessAddress?: { street?: string; city?: string; state?: string; postalCode?: string; countryOrRegion?: string }; homeAddress?: typeof c['businessAddress']; categories?: string[] };
      const lines: string[] = [];
      lines.push(`Name: ${c.displayName ?? `${c.givenName ?? ''} ${c.surname ?? ''}`.trim() ?? '(no name)'}`);
      if (c.companyName) lines.push(`Company: ${c.companyName}${c.jobTitle ? ` — ${c.jobTitle}` : ''}`);
      if (c.emailAddresses && c.emailAddresses.length > 0) {
        lines.push(`Email(s): ${c.emailAddresses.map(e => e.address).filter(Boolean).join(', ')}`);
      }
      const phones: string[] = [];
      if (c.mobilePhone) phones.push(`mobile ${c.mobilePhone}`);
      if (c.businessPhones && c.businessPhones.length > 0) phones.push(...c.businessPhones.map(p => `work ${p}`));
      if (c.homePhones && c.homePhones.length > 0) phones.push(...c.homePhones.map(p => `home ${p}`));
      if (phones.length > 0) lines.push(`Phone(s): ${phones.join(', ')}`);
      const formatAddr = (a?: { street?: string; city?: string; state?: string; postalCode?: string; countryOrRegion?: string }) => {
        if (!a) return '';
        return [a.street, a.city, a.state, a.postalCode, a.countryOrRegion].filter(Boolean).join(', ');
      };
      const business = formatAddr(c.businessAddress);
      const home = formatAddr(c.homeAddress);
      if (business) lines.push(`Business address: ${business}`);
      if (home) lines.push(`Home address: ${home}`);
      if (c.birthday) lines.push(`Birthday: ${c.birthday.slice(0, 10)}`);
      if (c.categories && c.categories.length > 0) lines.push(`Categories: ${c.categories.join(', ')}`);
      if (c.personalNotes) lines.push(`Notes: ${c.personalNotes}`);
      lines.push(`ID: ${c.id}`);
      return lines.join('\n');
    }

    case 'onenote_list_notebooks': {
      const result = await msGraphRead(
        'me/onenote/notebooks?$select=id,displayName,isDefault,isShared,createdDateTime,lastModifiedDateTime',
        agentId, agentName, 'onenote_list_notebooks', {}, slot,
      );
      if (!result.ok) return `Error listing notebooks: ${result.error}`;
      const data = result.data as { value?: Array<{ id: string; displayName: string; isDefault?: boolean; isShared?: boolean }> };
      const books = data?.value ?? [];
      if (books.length === 0) return 'No OneNote notebooks found.';
      const lines = books.map(n => {
        const tags: string[] = [];
        if (n.isDefault) tags.push('DEFAULT');
        if (n.isShared) tags.push('shared');
        const tagStr = tags.length > 0 ? ` [${tags.join(', ')}]` : '';
        return `- ${n.displayName}${tagStr}\n    ID: ${n.id}`;
      });
      return `${books.length} notebook(s):\n\n${lines.join('\n')}\n\nUse onenote_list_sections(notebook_id) to see what's inside.`;
    }

    case 'onenote_list_sections': {
      const notebookId = encodeURIComponent(args.notebook_id as string);
      const result = await msGraphRead(
        `me/onenote/notebooks/${notebookId}/sections?$select=id,displayName,createdDateTime,lastModifiedDateTime`,
        agentId, agentName, 'onenote_list_sections', { notebookId: args.notebook_id }, slot,
      );
      if (!result.ok) return `Error listing sections: ${result.error}`;
      const data = result.data as { value?: Array<{ id: string; displayName: string }> };
      const sections = data?.value ?? [];
      if (sections.length === 0) return 'No sections in this notebook.';
      return `${sections.length} section(s):\n\n${sections.map(s => `- ${s.displayName}\n    ID: ${s.id}`).join('\n')}\n\nUse onenote_list_pages(section_id) to see pages.`;
    }

    case 'onenote_list_pages': {
      const sectionId = encodeURIComponent(args.section_id as string);
      const maxResults = Math.min((args.max_results as number) ?? 25, 100);
      const result = await msGraphRead(
        `me/onenote/sections/${sectionId}/pages?$top=${maxResults}&$select=id,title,createdDateTime,lastModifiedDateTime&$orderby=${encodeURIComponent('lastModifiedDateTime desc')}`,
        agentId, agentName, 'onenote_list_pages', { sectionId: args.section_id, maxResults }, slot,
      );
      if (!result.ok) return `Error listing pages: ${result.error}`;
      const data = result.data as { value?: Array<{ id: string; title: string; lastModifiedDateTime: string }> };
      const pages = data?.value ?? [];
      if (pages.length === 0) return 'No pages in this section.';
      const { formatTimeForAgent } = await import('../services/format-time.js');
      const lines = pages.map(p => `- ${p.title || '(untitled)'} | modified ${formatTimeForAgent(p.lastModifiedDateTime)}\n    ID: ${p.id}`);
      return `${pages.length} page(s):\n\n${lines.join('\n')}\n\nUse onenote_read_page(page_id) for content.`;
    }

    case 'onenote_read_page': {
      const pageId = encodeURIComponent(args.page_id as string);
      const offset = Math.max((args.offset as number) ?? 0, 0);
      const limit = Math.min(Math.max((args.limit as number) ?? 16000, 100), 50000);
      // OneNote returns raw HTML from the `/content` endpoint, NOT JSON.
      // msGraphRead expects JSON, so use a raw fetch via the auth token here.
      const token = await (await import('./auth.js')).getValidAccessTokenForAccount(slot);
      if (!token) return 'Error: not authenticated with Microsoft.';
      try {
        const resp = await fetch(`https://graph.microsoft.com/v1.0/me/onenote/pages/${pageId}/content`, {
          headers: { Authorization: `Bearer ${token}` },
          signal: AbortSignal.timeout(30_000),
        });
        if (!resp.ok) {
          const errText = await resp.text();
          return `Error reading OneNote page: ${errText.slice(0, 300)}`;
        }
        const fullHtml = await resp.text();
        const total = fullHtml.length;
        const slice = fullHtml.slice(offset, offset + limit);
        const more = offset + limit < total
          ? `\n\n[... truncated. ${total - (offset + limit)} more characters. Next page: onenote_read_page(page_id="${args.page_id}", offset=${offset + limit}, limit=${limit}) ...]`
          : '';
        return `Page content (chars ${offset}-${Math.min(offset + limit, total)} of ${total}):\n\n${slice}${more}`;
      } catch (err) {
        return `Error reading OneNote page: ${err instanceof Error ? err.message : String(err)}`;
      }
    }

    default:
      return `Unknown Microsoft read tool: ${name}`;
  }
}

interface MicrosoftContact {
  id: string;
  displayName?: string;
  givenName?: string;
  surname?: string;
  emailAddresses?: Array<{ address?: string; name?: string }>;
  mobilePhone?: string;
  businessPhones?: string[];
  homePhones?: string[];
  companyName?: string;
  jobTitle?: string;
}

function formatContactLine(c: MicrosoftContact): string {
  const name = c.displayName?.trim() || `${c.givenName ?? ''} ${c.surname ?? ''}`.trim() || '(no name)';
  const email = c.emailAddresses?.[0]?.address ?? '';
  const phone = c.mobilePhone ?? c.businessPhones?.[0] ?? c.homePhones?.[0] ?? '';
  const company = c.companyName ? ` | ${c.companyName}${c.jobTitle ? ` (${c.jobTitle})` : ''}` : '';
  const contact = [email, phone].filter(Boolean).join(' / ');
  return `- ${name}${contact ? ` <${contact}>` : ''}${company}\n    ID: ${c.id}`;
}
