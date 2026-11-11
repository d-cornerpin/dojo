// UNIFIED CROSS-ACCOUNT READS: `calendar_agenda` and `email_search` merge
// Google and Microsoft accounts into one answer. `calendar_agenda` stays filed
// under "Google Calendar": the category string is on the wire in the tool index.

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
