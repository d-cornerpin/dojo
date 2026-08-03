// ════════════════════════════════════════════════════════════════════════════
// AGENT CREDENTIALS (PHASE-5 T4 — relocated from `agent/tools.ts`)
//
// `credential_list` / `_get` / `_add` / `_update` / `_delete` on one case body.
//
// The declared SECRET fields on these definitions (PHASE-4 T5b / PHASE-5 T1's
// `secret: true`) are what keeps a stored key out of the persisted `tool_use`
// arguments; that machinery lives in `credentials/secret-fields.ts` and on the
// definitions, never in this body, so the move cannot disturb it.
//
// RELOCATION, NOT REWRITE.
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

// The switch reached these bodies through fall-through labels; the table is
// keyed on the dispatch key, so every label is a key pointing at the same
// function. One line per tool, so `git grep <tool>` still lands here.
export const credentialsHandlers: ToolHandlerMap = {
  ...handlers,
  credential_get: handlers.credential_list,
  credential_add: handlers.credential_list,
  credential_update: handlers.credential_list,
  credential_delete: handlers.credential_list,
};
