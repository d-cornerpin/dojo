// ════════════════════════════════════════════════════════════════════════════
// Five credential tools; `credentials/secret-fields.ts` (not this body) keeps keys out of persisted args.
// ════════════════════════════════════════════════════════════════════════════

import { executeCredentialTool } from '../../../credentials/tools.js';
import type { ToolHandler, ToolHandlerMap } from '../handler.js';

const handlers = {
  async "credential_list"({ agentId, name, args }) {
    let content = '';
    let isError = false;
    content = await executeCredentialTool(name, args, agentId);
    isError = content.startsWith('Error');
    return { content, isError };
  },
} satisfies Record<string, ToolHandler>;

export const credentialsHandlers: ToolHandlerMap = {
  ...handlers,
  credential_get: handlers.credential_list,
  credential_add: handlers.credential_list,
  credential_update: handlers.credential_list,
  credential_delete: handlers.credential_list,
};
