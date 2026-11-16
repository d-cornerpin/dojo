// PLAUD: the recorder tools, each running `npx -y @plaud-ai/cli@latest`: a network-fetched package as a
// subprocess, declared as an effect on the tool definitions, not this module's to change.

import { isPlaudConnected } from '../../../plaud/auth.js';
import { plaudReadToolDefinitions, executePlaudTool } from '../../../plaud/tools-read.js';
import { isPrimaryAgent } from '../../../config/platform.js';
import { mayUsePlaud } from '../../access/read.js';
import type { ToolHandler, ToolHandlerMap } from '../handler.js';

const plaudBody: ToolHandler = async ({ agentId, name, args }) => {
  if (!isPrimaryAgent(agentId) && !mayUsePlaud(agentId)) {
    return { content: 'Permission denied: this agent holds no Plaud grant.', isError: true, errorCode: 'PERMISSION_DENIED' };
  }
  if (!isPlaudConnected()) {
    return { content: 'Plaud is not connected. Ask the owner to connect Plaud from Settings → Integrations → Plaud.', isError: true };
  }
  // The agent id rides along: expiry notices surface in THIS conversation.
  const content = await executePlaudTool(name, args, agentId);
  return { content, isError: content.startsWith('Error') || content.startsWith('Plaud is no longer connected') };
};

export const plaudHandlers: ToolHandlerMap = Object.fromEntries(plaudReadToolDefinitions.map((d) => [d.name, plaudBody]));
