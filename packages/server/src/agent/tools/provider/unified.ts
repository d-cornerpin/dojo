// ════════════════════════════════════════════════════════════════════════════
// UNIFIED CROSS-ACCOUNT READS (PHASE-5 T4 — relocated from `agent/tools.ts`)
//
// `calendar_agenda` and `email_search` merge Google and Microsoft accounts into
// one answer. Research 05 §1 flags `calendar_agenda` as a CATEGORY LIE — it is
// filed under "Google Calendar" while being a merged cross-account read — and
// the note is still true; the category STRING is on the wire in the tool index,
// so this module is a code boundary and deliberately not a re-categorisation.
//
// RELOCATION, NOT REWRITE.
// ════════════════════════════════════════════════════════════════════════════

import { unifiedCalendarAgenda, unifiedEmailSearch } from '../../../tools/unified-read.js';
import { getDb } from '../../../db/connection.js';
import type { ToolHandler, ToolHandlerMap } from '../handler.js';

const handlers = {
  async "calendar_agenda"({ agentId, args }) {
    let content = '';
    let isError = false;
    const agentRow = getDb().prepare('SELECT name FROM agents WHERE id = ?').get(agentId) as { name: string } | undefined;
    content = await unifiedCalendarAgenda(args, agentId, agentRow?.name ?? agentId);
    isError = content.startsWith('Error');
    return { content, isError };
  },

  async "email_search"({ agentId, args }) {
    let content = '';
    let isError = false;
    const agentRow = getDb().prepare('SELECT name FROM agents WHERE id = ?').get(agentId) as { name: string } | undefined;
    content = await unifiedEmailSearch(args, agentId, agentRow?.name ?? agentId);
    isError = content.startsWith('Error');
    return { content, isError };
  },
} satisfies Record<string, ToolHandler>;

export const unifiedHandlers: ToolHandlerMap = {
  ...handlers,
};
