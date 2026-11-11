// PLAUD: eight recorder tools on one case body, each running
// `npx -y @plaud-ai/cli@latest`: a network-fetched package as a subprocess,
// declared as an effect on the tool definitions, not this module's to change.

import { isPlaudConnected } from '../../../plaud/auth.js';
import { executePlaudTool } from '../../../plaud/tools-read.js';
import type { ToolHandler, ToolHandlerMap } from '../handler.js';

const handlers = {
  async "plaud_list_recordings"({ agentId, name, args }) {
    let content = '';
    let isError = false;
    if (!isPlaudConnected()) {
      content = 'Plaud is not connected. Ask the owner to connect Plaud from Settings → Integrations → Plaud.';
      isError = true;
      return { content, isError };
    }
    // The agent id rides along: expiry notices surface in THIS conversation.
    content = await executePlaudTool(name, args, agentId);
    isError = content.startsWith('Error') || content.startsWith('Plaud is no longer connected');
    return { content, isError };
  },
} satisfies Record<string, ToolHandler>;

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
