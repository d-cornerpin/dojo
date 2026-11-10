// The tool name says WHICH account, the agent's own grants say HOW MUCH: no shared role ladder.

import type { AccountKind } from '@dojo/shared';
import { channelForTool } from './channels.js';
import { integrationLevelFor, mayUseChannel } from './read.js';

export type WorkspaceProvider = 'google' | 'microsoft';

export function accountKindForTool(tool: string): AccountKind {
  return tool.startsWith('user_') ? 'user' : 'agent';
}

export function mayReadWorkspace(agentId: string, tool: string, provider: WorkspaceProvider): boolean {
  return integrationLevelFor(agentId, provider, accountKindForTool(tool)) !== 'none';
}

/** A write that reaches a person also needs the channel grant: 'full' without email sends no mail. */
export function mayWriteWorkspace(agentId: string, tool: string, provider: WorkspaceProvider): boolean {
  if (integrationLevelFor(agentId, provider, accountKindForTool(tool)) !== 'full') return false;
  const channel = channelForTool(tool);
  return channel === null || mayUseChannel(agentId, channel);
}
