// ════════════════════════════════════════════════════════════════════════════
// PLAUD (PHASE-5 T4 — relocated from `agent/tools.ts`)
//
// Eight recorder tools on one case body. §T0-PINS P3 records the boundary fact
// worth knowing here: every one of these runs `npx -y @plaud-ai/cli@latest`,
// i.e. a network-fetched package executed as a subprocess. That is declared on
// the definitions as an effect (T1) and it is not this module's to change.
//
// RELOCATION, NOT REWRITE.
// ════════════════════════════════════════════════════════════════════════════

import { isPlaudConnected } from '../../../plaud/auth.js';
import { executePlaudTool } from '../../../plaud/tools-read.js';
import type { ToolHandler, ToolHandlerMap } from '../handler.js';

const handlers = {
  async "plaud_list_recordings"({ agentId, name, args }) {
    let content = '';
    let isError = false;
    if (!isPlaudConnected()) {
      content = 'Plaud is not connected. Ask the user to connect Plaud from Settings → Integrations → Plaud.';
      isError = true;
      return { content, isError };
    }
    // UX-REPAIR T38: the agent id rides along so an expiry noticed inside the
    // CLI call is told to THIS conversation — the toast lane is per-agent.
    content = await executePlaudTool(name, args, agentId);
    isError = content.startsWith('Error') || content.startsWith('Plaud is no longer connected');
    return { content, isError };
  },
} satisfies Record<string, ToolHandler>;

// The switch reached these bodies through fall-through labels; the table is
// keyed on the dispatch key, so every label is a key pointing at the same
// function. One line per tool, so `git grep <tool>` still lands here.
export const plaudHandlers: ToolHandlerMap = {
  ...handlers,
  plaud_recent_recordings: handlers.plaud_list_recordings,
  plaud_search_recordings: handlers.plaud_list_recordings,
  plaud_get_recording: handlers.plaud_list_recordings,
  plaud_get_transcript: handlers.plaud_list_recordings,
  plaud_get_summary: handlers.plaud_list_recordings,
  plaud_get_audio_url: handlers.plaud_list_recordings,
  plaud_account_info: handlers.plaud_list_recordings,
};
