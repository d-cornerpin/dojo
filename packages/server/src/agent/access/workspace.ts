// The tool name says WHICH kind of account, the agent's own grants say HOW MUCH: no shared role ladder.

import type { AccountKind, IntegrationLevel } from '@dojo/shared';
import { isPrimaryAgent } from '../../config/platform.js';
import type { ToolDefinition } from '../tools/types.js';
import { channelForTool } from './channels.js';
import { integrationLevelFor, mayUseChannel } from './read.js';

export type WorkspaceProvider = 'google' | 'microsoft';

export function accountKindForTool(tool: string): AccountKind {
  return tool.startsWith('user_') ? 'user' : 'agent';
}

/** A write needs the full level; anything else needs some level. */
export function levelAllows(level: IntegrationLevel, def: Pick<ToolDefinition, 'writes'>): boolean {
  return def.writes ? level === 'full' : level !== 'none';
}

// The per-account service switch each tool family answers to, matched on the name without `user_`.
const SERVICE_PREFIXES: Record<WorkspaceProvider, Record<string, string[]>> = {
  google: { gmail: ['gmail_'], calendar: ['calendar_'], drive: ['drive_'], docs: ['docs_'], sheets: ['sheets_'], slides: ['slides_'], forms: ['forms_'] },
  microsoft: { outlook: ['outlook_'], calendar: ['calendar_'], onedrive: ['onedrive_', 'sharepoint_'], teams: ['teams_', 'online_meeting_'], contacts: ['contacts_'], onenote: ['onenote_'], tasks: ['tasks_'] },
};

export function serviceOfTool(provider: WorkspaceProvider, tool: string): string | null {
  const base = tool.startsWith('user_') ? tool.slice('user_'.length) : tool;
  for (const [service, prefixes] of Object.entries(SERVICE_PREFIXES[provider])) {
    if (prefixes.some((p) => base.startsWith(p))) return service;
  }
  return null;
}

/** A service is on unless the account's JSON sets it false (every default is on). */
export function serviceEnabled(enabledServices: string | null, service: string): boolean {
  if (!enabledServices) return true;
  try {
    return (JSON.parse(enabledServices) as Record<string, unknown>)[service] !== false;
  } catch {
    return true;
  }
}

/** THE account door, asked once the account is resolved: null to run, else the refusal. The main agent holds
 *  every account; another agent needs its grant on that account, a send its channel, and the service on. */
export function accountRefusal(
  agentId: string,
  def: Pick<ToolDefinition, 'name' | 'writes'>,
  provider: WorkspaceProvider,
  account: { id: string | null; kind: AccountKind; enabledServices: string | null },
): string | null {
  if (isPrimaryAgent(agentId)) return null;
  const label = provider === 'google' ? 'Google' : 'Microsoft';
  if (!levelAllows(integrationLevelFor(agentId, provider, account.kind, account.id), def)) {
    return `Permission denied: this agent's grants do not give it ${def.writes ? 'write' : 'read'} access to that ${label} account.`;
  }
  const channel = channelForTool(def.name);
  if (channel && !mayUseChannel(agentId, channel)) {
    return `Permission denied: ${def.name} reaches people by ${channel}, and this agent holds no ${channel} grant.`;
  }
  const service = serviceOfTool(provider, def.name);
  if (service && !serviceEnabled(account.enabledServices, service)) {
    return `Permission denied: ${service} is switched off on that ${label} account in Settings.`;
  }
  return null;
}
