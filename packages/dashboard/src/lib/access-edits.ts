// ════════════════════════════════════════════════════════════════════════════
// The access panel's grant math: pure, no React, so a change's meaning is not re-derived at call sites.
// '*' is a promise about the future: unticking one item under it expands to today's list minus that one,
//  so no grant is silently kept for a category invented next month.
// ════════════════════════════════════════════════════════════════════════════

import type { AccessChannel, AccessGrants, ChannelTier, IntegrationLevel } from '@dojo/shared';
import { ACCESS_CHANNELS, cloneGrants, providerLevelOf, stableGrantsText, techniqueGrantOf } from '@dojo/shared';

export type Provider = 'google' | 'microsoft';

export interface AccountRow {
  id: string;
  kind: 'agent' | 'user';
  email: string | null;
  connected: boolean;
}

export const clone = (g: AccessGrants): AccessGrants => cloneGrants(g);

// Tool groups are a MODE, not a checkbox: "Full" is exactly '*'; individual shows the group boxes.
// The model is unchanged and the mapping exact, so the capability diff stays empty.

export type ToolMode = 'full' | 'individual';

export const toolMode = (g: AccessGrants): ToolMode =>
  g.tools.categories === '*' ? 'full' : 'individual';

export const categoryChecked = (g: AccessGrants, label: string): boolean =>
  g.tools.categories === '*' || g.tools.categories.includes(label);

/** Switching Full to individual EXPANDS, it does not blank: the honest start for a bounded list
 *  is today's whole list; writing `[]` here would strip every tool the agent holds. */
export function setToolMode(g: AccessGrants, mode: ToolMode, allLabels: string[]): AccessGrants {
  // With no label list, going Individual would write an empty list and strip every tool. Refuse.
  if (mode === 'individual' && g.tools.categories === '*' && allLabels.length === 0) return clone(g);
  const next = clone(g);
  next.tools.categories = mode === 'full'
    ? '*'
    : (next.tools.categories === '*' ? [...allLabels] : [...next.tools.categories]);
  return next;
}

// Techniques: the same '*' promise as the tool groups, for the same reason. techniqueGrantOf
//  makes a row written without the key read as the '*' it means. On = holds any grant.

export const techniqueAccessOn = (g: AccessGrants): boolean => {
  const t = techniqueGrantOf(g);
  return t === '*' || t.length > 0;
};

export function setTechniqueAccess(g: AccessGrants, on: boolean, allIds: string[]): AccessGrants {
  const next = clone(g);
  next.techniques = on ? '*' : [];
  void allIds;
  return next;
}

export const techniqueChecked = (g: AccessGrants, id: string): boolean => {
  const t = techniqueGrantOf(g);
  return t === '*' || t.includes(id);
};

export function setTechnique(g: AccessGrants, id: string, on: boolean, allIds: string[]): AccessGrants {
  const next = clone(g);
  const current = techniqueGrantOf(next);
  const list = current === '*' ? [...allIds] : [...current];
  next.techniques = on
    ? (list.includes(id) ? list : [...list, id])
    : list.filter((t) => t !== id);
  return next;
}

/** Tick or untick one group. Under `'*'`, unticking EXPANDS to today's list
 *  minus that group rather than quietly keeping tomorrow's. */
export function setCategory(g: AccessGrants, label: string, on: boolean, allLabels: string[]): AccessGrants {
  const next = clone(g);
  const current = next.tools.categories === '*' ? [...allLabels] : [...next.tools.categories];
  next.tools.categories = on
    ? (current.includes(label) ? current : [...current, label])
    : current.filter((c) => c !== label);
  return next;
}

// One toggle for stored credentials: the field is a boolean, so there is no finer reading to lie about.

export const credentialsGranted = (g: AccessGrants): boolean => g.integrations.credentials;

export function setCredentials(g: AccessGrants, on: boolean): AccessGrants {
  const next = clone(g);
  next.integrations.credentials = on;
  return next;
}


export function setPlaud(g: AccessGrants, on: boolean): AccessGrants {
  const next = clone(g);
  next.integrations.plaud = on;
  return next;
}

/** The level this agent holds on one connected account. */
export const accountLevel = (g: AccessGrants, provider: Provider, row: AccountRow): IntegrationLevel =>
  providerLevelOf(g.integrations[provider], row.kind, row.id);

const WIDEST: IntegrationLevel[] = ['none', 'read', 'full'];
const widest = (levels: IntegrationLevel[]): IntegrationLevel =>
  levels.reduce<IntegrationLevel>((a, b) => (WIDEST.indexOf(b) > WIDEST.indexOf(a) ? b : a), 'none');

/** Sets one account's level and keeps the KIND level at the widest account of that kind: the
 *  strip reads the kind, the door the account; a drift is advertised but refused at the door. */
export function setAccountLevel(
  g: AccessGrants,
  provider: Provider,
  row: AccountRow,
  level: IntegrationLevel,
  allRows: AccountRow[],
): AccessGrants {
  const next = clone(g);
  const p = next.integrations[provider];
  p.accounts = { ...(p.accounts ?? {}), [row.id]: level };
  for (const kind of ['agent', 'user'] as const) {
    const ofKind = allRows.filter((r) => r.kind === kind);
    if (ofKind.length === 0) continue;
    p[kind] = widest(ofKind.map((r) => (r.id === row.id ? level : providerLevelOf(p, kind, r.id))));
  }
  return next;
}

/** The kind-level control, for a provider with no connected accounts yet. */
export function setKindLevel(g: AccessGrants, provider: Provider, kind: 'agent' | 'user', level: IntegrationLevel): AccessGrants {
  const next = clone(g);
  next.integrations[provider][kind] = level;
  return next;
}


export const hasMaster = (g: AccessGrants): boolean => g.channels.master !== null;
export const masterOn = (g: AccessGrants): boolean => g.channels.master === true;

/** The master reveals its children; turning it ON defaults every channel to 'owner', never
 *  'all': it says this agent may talk to people, not which people. The default only fires when
 *  every child is 'none', so a stored set survives a flip off and back. OFF never touches one. */
export function setMaster(g: AccessGrants, on: boolean): AccessGrants {
  const next = clone(g);
  next.channels.master = on;
  if (on && ACCESS_CHANNELS.every((c) => next.channels[c] === 'none')) {
    for (const c of ACCESS_CHANNELS) next.channels[c] = 'owner';
  }
  return next;
}

export function setChannelTier(g: AccessGrants, channel: AccessChannel, tier: ChannelTier): AccessGrants {
  const next = clone(g);
  next.channels[channel] = tier;
  return next;
}

/** Channels the draft grants whose TOOL GROUP it does not: the grant that looks set and does
 *  nothing. Said on screen rather than refused, since refusing would silently tick a group. */
export function inertChannels(
  g: AccessGrants,
  channelGroups: Record<string, string[]>,
): Array<{ channel: AccessChannel; groups: string[] }> {
  if (g.channels.master !== true) return [];
  const out: Array<{ channel: AccessChannel; groups: string[] }> = [];
  for (const channel of ACCESS_CHANNELS) {
    if (g.channels[channel] === 'none') continue;
    const groups = channelGroups[channel] ?? [];
    if (groups.length === 0) continue;
    const held = g.tools.categories === '*' || groups.some((label) => g.tools.categories.includes(label));
    if (!held) out.push({ channel, groups });
  }
  return out;
}

/** Write-granted mail accounts whose send path is shut: "Read & write" reads as "it can send
 *  now", but sending is a human channel needing master then Email; without it write buys reading,
 *  filing, drafting. Two reasons, read separately: master off, or master on with Email off.
 *  A helper agent (master null) is never warned: it has no switch of its own to point at. */
export function mailWriteWithoutSend(
  g: AccessGrants,
): Array<{ provider: Provider; missing: 'master' | 'email' }> {
  if (g.channels.master === null) return [];
  const missing = g.channels.master !== true ? 'master' : g.channels.email === 'none' ? 'email' : null;
  if (missing === null) return [];

  const out: Array<{ provider: Provider; missing: 'master' | 'email' }> = [];
  for (const provider of ['google', 'microsoft'] as const) {
    const p = g.integrations[provider];
    const writes = p.agent === 'full' || p.user === 'full'
      || Object.values(p.accounts ?? {}).some((level) => level === 'full');
    if (writes) out.push({ provider, missing });
  }
  return out;
}


type Patch = Record<string, unknown>;

/** Only what moved, in grantsPatchSchema's shape; an empty object is what the Save button reads.
 *  channels is omitted entirely for an agent with no master, so the rule holds at the wire. */
export function grantsPatch(original: AccessGrants, draft: AccessGrants): Patch {
  const patch: Patch = {};
  const moved = (a: unknown, b: unknown): boolean => stableGrantsText(a) !== stableGrantsText(b);

  const tools: Patch = {};
  if (moved(original.tools.categories, draft.tools.categories)) tools.categories = draft.tools.categories;
  if (moved(original.tools.allow, draft.tools.allow)) tools.allow = draft.tools.allow;
  if (moved(original.tools.deny, draft.tools.deny)) tools.deny = draft.tools.deny;
  if (Object.keys(tools).length > 0) patch.tools = tools;

  const integrations: Patch = {};
  if (original.integrations.plaud !== draft.integrations.plaud) integrations.plaud = draft.integrations.plaud;
  if (original.integrations.credentials !== draft.integrations.credentials) {
    integrations.credentials = draft.integrations.credentials;
  }
  for (const provider of ['google', 'microsoft'] as const) {
    const p: Patch = {};
    const before = original.integrations[provider];
    const after = draft.integrations[provider];
    if (before.agent !== after.agent) p.agent = after.agent;
    if (before.user !== after.user) p.user = after.user;
    if (moved(before.accounts ?? {}, after.accounts ?? {})) p.accounts = after.accounts ?? {};
    if (Object.keys(p).length > 0) integrations[provider] = p;
  }
  if (Object.keys(integrations).length > 0) patch.integrations = integrations;

  if (hasMaster(draft)) {
    const channels: Patch = {};
    if (original.channels.master !== draft.channels.master) channels.master = draft.channels.master;
    for (const channel of ACCESS_CHANNELS) {
      if (original.channels[channel] !== draft.channels[channel]) channels[channel] = draft.channels[channel];
    }
    if (Object.keys(channels).length > 0) patch.channels = channels;
  }

  if (moved(techniqueGrantOf(original), techniqueGrantOf(draft))) {
    patch.techniques = techniqueGrantOf(draft);
  }

  return patch;
}

export const isDirty = (original: AccessGrants, draft: AccessGrants): boolean =>
  Object.keys(grantsPatch(original, draft)).length > 0;
