// Access grants: one object per agent stating what it may reach, stored in `agents.permissions`.
// Every per-channel grant is inert unless `channels.master` is true, so only `channelTierOf()` reads one.

export const ACCESS_CHANNELS = ['imessage', 'sms', 'voice', 'email', 'teams'] as const;
export type AccessChannel = (typeof ACCESS_CHANNELS)[number];

/** none: not granted. owner: only the is_primary safe-sender. all: every approved recipient. */
export type ChannelTier = 'none' | 'owner' | 'all';

export type IntegrationLevel = 'none' | 'read' | 'full';

export type AccountKind = 'agent' | 'user';

export interface ChannelGrants {
  /** Master switch: null means no such toggle (not 'on'), and channelTierOf answers 'none'. */
  master: boolean | null;
  imessage: ChannelTier;
  sms: ChannelTier;
  voice: ChannelTier;
  email: ChannelTier;
  teams: ChannelTier;
}

export interface ProviderGrants {
  agent: IntegrationLevel;
  user: IntegrationLevel;
  accounts?: Record<string, IntegrationLevel>;
}

export interface IntegrationGrants {
  plaud: boolean;
  /** Reach the credential store at all; legacy stored values fold via foldCredentialGrant. */
  credentials: boolean;
  google: ProviderGrants;
  microsoft: ProviderGrants;
}

export interface ToolGrants {
  categories: string[] | '*';
  allow: string[];
  /** Deny wins over everything, at the surface AND at the executor. */
  deny: string[];
}

export interface AccessGrants {
  v: 1;
  tools: ToolGrants;
  integrations: IntegrationGrants;
  channels: ChannelGrants;
  /** Techniques this agent may run ('*' = all); absent reads as '*' (techniqueGrantOf). */
  techniques?: string[] | '*';
}


/** The master switch applies here and only here: a per-channel 'all' under a false or null master is 'none'. */
export function channelTierOf(grants: AccessGrants, channel: AccessChannel): ChannelTier {
  if (grants.channels.master !== true) return 'none';
  return grants.channels[channel] ?? 'none';
}

export function mayReachChannel(grants: AccessGrants, channel: AccessChannel): boolean {
  return channelTierOf(grants, channel) !== 'none';
}

export function mayReachOthersOn(grants: AccessGrants, channel: AccessChannel): boolean {
  return channelTierOf(grants, channel) === 'all';
}

export function providerLevelOf(
  provider: ProviderGrants,
  kind: AccountKind,
  accountId?: string | null,
): IntegrationLevel {
  if (accountId && provider.accounts && accountId in provider.accounts) {
    return provider.accounts[accountId];
  }
  return provider[kind] ?? 'none';
}

export function foldCredentialGrant(stored: unknown): boolean {
  if (typeof stored === 'boolean') return stored;
  if (stored === '*') return true;
  if (Array.isArray(stored)) return stored.length > 0;
  return false;
}

export function categoryGranted(grants: AccessGrants, label: string): boolean {
  const cats = grants.tools.categories;
  return cats === '*' || cats.includes(label);
}

/** The technique grant; a stored object with no `techniques` key means every technique ('*'). */
export function techniqueGrantOf(grants: AccessGrants): string[] | '*' {
  return grants.techniques ?? '*';
}

export function techniqueGranted(grants: AccessGrants, techniqueId: string): boolean {
  const t = techniqueGrantOf(grants);
  return t === '*' || t.includes(techniqueId);
}

// Files, scratchpad, the sub-agent lifecycle (complete_task, send_to_agent) and the work tracker; nothing
// reaches outside the dojo. 'Managing Other Agents' widens nothing: spawn_agent, kill_agent and
// spawn_timeout_decision stay behind can_spawn_agents, update_agent and the group-editing verbs behind
// PRIMARY_ONLY_TOOLS (agent/tools/surface.ts). A creation default only, never re-applied at boot
// (access/materialize.ts writes only agents with no grants), so an owner's revocation survives restarts.
export const MOST_RESTRICTIVE_GRANTS: AccessGrants = {
  v: 1,
  tools: {
    categories: [
      'Meta', 'File & System', 'Managing Other Agents',
      // The work tracker; migration 168_work_tracker_default_grant.sql names the same two strings.
      'Open Work (what you still owe)',
      'Work Tracker (projects, tasks, reminders, promises)',
    ],
    allow: [],
    deny: [],
  },
  integrations: {
    plaud: false,
    credentials: false,
    google: { agent: 'none', user: 'none' },
    microsoft: { agent: 'none', user: 'none' },
  },
  channels: { master: false, imessage: 'none', sms: 'none', voice: 'none', email: 'none', teams: 'none' },
  // No technique by default: a technique is a standing procedure injected unasked, so it is granted explicitly.
  techniques: [],
};

export function cloneGrants(g: AccessGrants): AccessGrants {
  return JSON.parse(JSON.stringify(g)) as AccessGrants;
}

export function stableGrantsText(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(stableGrantsText).join(',')}]`;
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableGrantsText(obj[k])}`).join(',')}}`;
}
