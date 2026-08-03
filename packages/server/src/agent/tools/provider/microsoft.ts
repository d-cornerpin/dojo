// ════════════════════════════════════════════════════════════════════════════
// MICROSOFT 365 (PHASE-5 T4 — relocated from `agent/tools.ts`)
//
// Sixty-four dispatch keys on TWO case bodies — every Outlook / Calendar /
// OneDrive / SharePoint / Teams / Contacts READ (plus the `user_*` slot
// variants) and every WRITE. The bodies branch on `name`;
// `executeMicrosoftReadTool` / `…WriteTool` strip the `user_` prefix and route
// through that slot's credentials.
//
// ⚠ THE READ BODY APPLIES THE USER-MAILBOX BANNER, AND THE FOUR
// `user_outlook_*` MAIL READS ARE THE EXACT TOOLS THE PLAN'S TRAP IS ABOUT.
// They are banner-eligible AND they are explicitly keyed here, which is the
// only reason they are bannered at all: the default membership branch in the
// executor applies the banner to Google reads and NOT to Microsoft ones, so a
// `user_outlook_read` that fell through to it would lose its banner silently.
// `provider/mailbox-banner.test.ts` now holds that invariant as a test — every
// `USER_MAILBOX_READ_TOOLS` name resolves in the handler table, and its handler
// banners the result.
//
// RELOCATION, NOT REWRITE.
// ════════════════════════════════════════════════════════════════════════════

import { getDb } from '../../../db/connection.js';
import { executeMicrosoftReadTool } from '../../../microsoft/tools-read.js';
import { executeMicrosoftWriteTool } from '../../../microsoft/tools-write.js';
import { prependUserMailboxBanner } from './mailbox-banner.js';
import { isPrimaryAgent } from '../../../config/platform.js';
import { auditLog } from '../util.js';
import type { ToolHandler, ToolHandlerMap } from '../handler.js';

const handlers = {
  async "outlook_search"({ agentId, name, args }) {
    let content = '';
    let isError = false;
    const agentRow = getDb().prepare('SELECT name FROM agents WHERE id = ?').get(agentId) as { name: string } | undefined;
    content = await executeMicrosoftReadTool(name, args, agentId, agentRow?.name ?? agentId);
    content = prependUserMailboxBanner(content, name);
    isError = content.startsWith('Error');
    return { content, isError };
  },

  async "outlook_send"({ agentId, name, args }) {
    let content = '';
    let isError = false;
    if (!isPrimaryAgent(agentId)) {
      content = 'Permission denied: only the primary agent can use Microsoft 365 write tools.';
      isError = true;
      auditLog(agentId, name, null, 'denied', 'Microsoft write tool restricted to primary agent');
      return { content, isError };
    }
    const agentRow = getDb().prepare('SELECT name FROM agents WHERE id = ?').get(agentId) as { name: string } | undefined;
    content = await executeMicrosoftWriteTool(name, args, agentId, agentRow?.name ?? agentId);
    isError = content.startsWith('Error');
    return { content, isError };
  },
} satisfies Record<string, ToolHandler>;

// The switch reached these bodies through fall-through labels; the table is
// keyed on the dispatch key, so every label is a key pointing at the same
// function. One line per tool, so `git grep <tool>` still lands here.
export const microsoftHandlers: ToolHandlerMap = {
  ...handlers,
  outlook_read: handlers.outlook_search,
  outlook_inbox: handlers.outlook_search,
  outlook_list_attachments: handlers.outlook_search,
  calendar_agenda_ms: handlers.outlook_search,
  calendar_search_ms: handlers.outlook_search,
  calendar_list_ms: handlers.outlook_search,
  calendar_share_invites_ms: handlers.outlook_search,
  onedrive_list: handlers.outlook_search,
  onedrive_read: handlers.outlook_search,
  onedrive_search: handlers.outlook_search,
  onedrive_list_shared: handlers.outlook_search,
  onedrive_list_drives: handlers.outlook_search,
  sharepoint_list_sites: handlers.outlook_search,
  sharepoint_list_drives: handlers.outlook_search,
  online_meeting_get: handlers.outlook_search,
  teams_read_messages: handlers.outlook_search,
  teams_list_teams: handlers.outlook_search,
  teams_list_channels: handlers.outlook_search,
  teams_read_channel_messages: handlers.outlook_search,
  teams_list_attachments: handlers.outlook_search,
  contacts_search: handlers.outlook_search,
  contacts_list: handlers.outlook_search,
  contacts_get: handlers.outlook_search,
  user_outlook_search: handlers.outlook_search,
  user_outlook_read: handlers.outlook_search,
  user_outlook_inbox: handlers.outlook_search,
  user_outlook_list_attachments: handlers.outlook_search,
  user_calendar_agenda_ms: handlers.outlook_search,
  user_calendar_search_ms: handlers.outlook_search,
  user_calendar_list_ms: handlers.outlook_search,
  user_onedrive_list: handlers.outlook_search,
  user_onedrive_read: handlers.outlook_search,
  user_onedrive_search: handlers.outlook_search,
  outlook_reply: handlers.outlook_send,
  outlook_forward: handlers.outlook_send,
  user_outlook_send: handlers.outlook_send,
  user_outlook_reply: handlers.outlook_send,
  user_outlook_forward: handlers.outlook_send,
  outlook_mark_read: handlers.outlook_send,
  outlook_delete: handlers.outlook_send,
  outlook_download_attachment: handlers.outlook_send,
  calendar_create_ms: handlers.outlook_send,
  calendar_update_ms: handlers.outlook_send,
  calendar_delete_ms: handlers.outlook_send,
  calendar_respond_invite_ms: handlers.outlook_send,
  calendar_accept_share_ms: handlers.outlook_send,
  onedrive_create_folder: handlers.outlook_send,
  onedrive_upload: handlers.outlook_send,
  onedrive_upload_batch: handlers.outlook_send,
  onedrive_share: handlers.outlook_send,
  onedrive_delete: handlers.outlook_send,
  onedrive_move: handlers.outlook_send,
  online_meeting_create: handlers.outlook_send,
  online_meeting_update: handlers.outlook_send,
  online_meeting_delete: handlers.outlook_send,
  teams_create_chat: handlers.outlook_send,
  teams_send_message: handlers.outlook_send,
  teams_send_channel_message: handlers.outlook_send,
  teams_download_attachment: handlers.outlook_send,
  contacts_create: handlers.outlook_send,
  contacts_update: handlers.outlook_send,
  contacts_delete: handlers.outlook_send,
};
