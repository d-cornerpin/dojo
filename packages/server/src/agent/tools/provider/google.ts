// GOOGLE WORKSPACE: forty-one dispatch keys on two case bodies, reads plus
// `user_*` slot variants on one, every write on the other. The executors strip
// the `user_` prefix and route through that slot's credentials.
// The read body applies the user-mailbox banner: the executor's default branch
// banners Google reads but not Microsoft ones, so a `user_*` key dropped there
// silently loses its banner. See `provider/mailbox-banner.ts`.

import { getDb } from '../../../db/connection.js';
import { executeGoogleReadTool } from '../../../google/tools-read.js';
import { executeGoogleWriteTool } from '../../../google/tools-write.js';
import { prependMailboxOwnerHeader } from './mailbox-banner.js';
// The predicate is this agent's own per-ACCOUNT grant; a send needs its channel
// grant too. See `access/workspace.ts`.
import { mayReadWorkspace, mayWriteWorkspace } from '../../access/workspace.js';
import { auditLog } from '../util.js';
import type { ToolHandler, ToolHandlerMap } from '../handler.js';

const handlers = {
  async "gmail_search"({ agentId, name, args }) {
    let content = '';
    let isError = false;
    // Required-field validation lives at the schema boundary above: base and
    // user_ variants take the same validated path.
    if (!mayReadWorkspace(agentId, name, 'google')) {
      auditLog(agentId, name, null, 'denied', 'Google account not in this agent\'s grants');
      return { content: 'Permission denied: that Google account is not in this agent\'s grants.', isError: true, errorCode: 'PERMISSION_DENIED' as const };
    }
    const agentRow = getDb().prepare('SELECT name FROM agents WHERE id = ?').get(agentId) as { name: string } | undefined;
    content = await executeGoogleReadTool(name, args, agentId, agentRow?.name ?? agentId);
    content = prependMailboxOwnerHeader(content, name, args);
    isError = content.startsWith('Error');
    return { content, isError };
  },

  async "gmail_send"({ agentId, name, args }) {
    let content = '';
    let isError = false;
    if (!mayWriteWorkspace(agentId, name, 'google')) {
      content = 'Permission denied: only the primary agent can use Google Workspace write tools.';
      isError = true;
      auditLog(agentId, name, null, 'denied', 'Google write tool restricted to primary agent');
      return { content, isError };
    }
    // No writeReqs map here: a hand-maintained one duplicates the schema
    // check and drifts from it.
    const agentRow = getDb().prepare('SELECT name FROM agents WHERE id = ?').get(agentId) as { name: string } | undefined;
    content = await executeGoogleWriteTool(name, args, agentId, agentRow?.name ?? agentId);
    isError = content.startsWith('Error');
    return { content, isError };
  },
} satisfies Record<string, ToolHandler>;

// The switch reached these bodies through fall-through labels; every label is
// its own key here, one line per tool, so `git grep <tool>` still lands on it.
export const googleHandlers: ToolHandlerMap = {
  ...handlers,
  gmail_read: handlers.gmail_search,
  gmail_list_attachments: handlers.gmail_search,
  gmail_inbox: handlers.gmail_search,
  calendar_search: handlers.gmail_search,
  calendar_list: handlers.gmail_search,
  drive_list: handlers.gmail_search,
  drive_read: handlers.gmail_search,
  docs_read: handlers.gmail_search,
  sheets_read: handlers.gmail_search,
  user_gmail_search: handlers.gmail_search,
  user_gmail_read: handlers.gmail_search,
  user_gmail_list_attachments: handlers.gmail_search,
  user_gmail_inbox: handlers.gmail_search,
  user_calendar_agenda: handlers.gmail_search,
  user_calendar_search: handlers.gmail_search,
  user_calendar_list: handlers.gmail_search,
  user_drive_list: handlers.gmail_search,
  user_drive_read: handlers.gmail_search,
  gmail_reply: handlers.gmail_send,
  gmail_forward: handlers.gmail_send,
  gmail_draft: handlers.gmail_send,
  user_gmail_send: handlers.gmail_send,
  user_gmail_reply: handlers.gmail_send,
  user_gmail_forward: handlers.gmail_send,
  user_gmail_draft: handlers.gmail_send,
  gmail_label: handlers.gmail_send,
  gmail_read_attachment: handlers.gmail_send,
  calendar_create: handlers.gmail_send,
  calendar_update: handlers.gmail_send,
  calendar_delete: handlers.gmail_send,
  calendar_respond_invite: handlers.gmail_send,
  calendar_subscribe: handlers.gmail_send,
  calendar_unsubscribe: handlers.gmail_send,
  drive_upload: handlers.gmail_send,
  drive_share: handlers.gmail_send,
  drive_delete: handlers.gmail_send,
  docs_create: handlers.gmail_send,
  docs_edit: handlers.gmail_send,
  sheets_create: handlers.gmail_send,
  sheets_append: handlers.gmail_send,
  sheets_write: handlers.gmail_send,
};
