// ════════════════════════════════════════════════════════════════════════════
// GOOGLE WORKSPACE (PHASE-5 T4 — relocated from `agent/tools.ts`)
//
// Forty-one dispatch keys on TWO case bodies: one for every Gmail / Calendar /
// Drive / Docs / Sheets READ (plus the `user_*` slot variants of each), and one
// for every WRITE. The bodies branch on `name`; `executeGoogleReadTool` and
// `executeGoogleWriteTool` strip the `user_` prefix and route through that
// slot's credentials.
//
// ⚠ THE READ BODY APPLIES THE USER-MAILBOX BANNER AND THAT IS A CAPABILITY, NOT
// A FORMATTING DETAIL. `prependUserMailboxBanner` moved to
// `provider/mailbox-banner.ts` with its own test, because the plan flagged this
// region as a trap: the default membership branch banners Google reads and not
// Microsoft ones, so dropping an explicit `user_*` label routes that tool
// through the branch and silently removes the banner. Read that module's header
// before touching either read body.
//
// RELOCATION, NOT REWRITE.
// ════════════════════════════════════════════════════════════════════════════

import { getDb } from '../../../db/connection.js';
import { executeGoogleReadTool } from '../../../google/tools-read.js';
import { executeGoogleWriteTool } from '../../../google/tools-write.js';
import { prependMailboxOwnerHeader } from './mailbox-banner.js';
import { isPrimaryAgent } from '../../../config/platform.js';
import { auditLog } from '../util.js';
import type { ToolHandler, ToolHandlerMap } from '../handler.js';

const handlers = {
  async "gmail_search"({ agentId, name, args }) {
    let content = '';
    let isError = false;
    // Required-field validation happens at the ONE boundary above, from
    // each tool's real input_schema. A hand-maintained readReqs map used to
    // sit here; it was pure duplication of that check and a drift risk, so
    // it was removed — and PHASE-5 T3 Step 3 finished the same job for the
    // per-dispatcher copy that replaced it. The schema is the single source
    // of truth, and base + user_ variants take the same validated path.
    const agentRow = getDb().prepare('SELECT name FROM agents WHERE id = ?').get(agentId) as { name: string } | undefined;
    content = await executeGoogleReadTool(name, args, agentId, agentRow?.name ?? agentId);
    content = prependMailboxOwnerHeader(content, name, args);
    isError = content.startsWith('Error');
    return { content, isError };
  },

  async "gmail_send"({ agentId, name, args }) {
    let content = '';
    let isError = false;
    // Double-check: only primary agent can use write tools (belt + suspenders)
    if (!isPrimaryAgent(agentId)) {
      content = 'Permission denied: only the primary agent can use Google Workspace write tools.';
      isError = true;
      auditLog(agentId, name, null, 'denied', 'Google write tool restricted to primary agent');
      return { content, isError };
    }
    // Required-field validation happens at the ONE boundary above, from
    // each tool's real input_schema. THIS IS THE INCIDENT THAT ARGUES FOR
    // ONE OWNER, so it stays written down: a hand-maintained writeReqs map
    // used to sit here; it duplicated that check and had DRIFTED (it
    // demanded a non-existent `content` field on drive_upload and an array
    // `values` on sheets_append whose schema and executor actually take a
    // comma-separated string), so every base call died at dispatch while the
    // user_ variants, which skip this case via the default membership
    // dispatch, worked. The map is gone; the schema is the single source of
    // truth and base + user_ variants now take the same validated path.
    const agentRow = getDb().prepare('SELECT name FROM agents WHERE id = ?').get(agentId) as { name: string } | undefined;
    content = await executeGoogleWriteTool(name, args, agentId, agentRow?.name ?? agentId);
    isError = content.startsWith('Error');
    return { content, isError };
  },
} satisfies Record<string, ToolHandler>;

// The switch reached these bodies through fall-through labels; the table is
// keyed on the dispatch key, so every label is a key pointing at the same
// function. One line per tool, so `git grep <tool>` still lands here.
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
  user_gmail_send: handlers.gmail_send,
  user_gmail_reply: handlers.gmail_send,
  user_gmail_forward: handlers.gmail_send,
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
