// ════════════════════════════════════════════════════════════════════════════
// THE ACCESS PANEL'S GRANT MATH (UX-ACCESS A3) — pure, no React.
//
// Split out of `AccessPanel.tsx` on the same seam `authorize.ts` and
// `gate-eval.ts` use on the server: what a change MEANS is a pure function of
// two objects, and the component is only allowed to render and to ask.
//
// The rules encoded here, each of which the panel would otherwise have to
// remember at half a dozen call sites:
//
//   · `'*'` is a PROMISE ABOUT THE FUTURE, not a full list. Unticking one group
//     under `'*'` expands to every group that exists today MINUS that one, so
//     the owner never silently keeps a grant for a category invented next month.
//   · A PATCH carries only what moved. `PUT /agents/:id {grants}` merges over the
//     agent's current object (A2), so sending the whole thing would make every
//     save look like a change in the audit log.
//   · An agent whose master is `null` HAS NO CHANNEL SECTION — owner ruling 1,
//     "sensei agents other than the primary have no such toggle; they
//     communicate through the main agent". The patch never names `channels` for
//     one, which is stronger than disabling a control.
//   · The KIND level follows the ACCOUNTS. The surface strip reads the per-KIND
//     level (A1 §6.6) while the door reads the per-ACCOUNT override, so unticking
//     every account of a kind has to narrow the kind too or the tools stay
//     advertised for an agent that can no longer use them.
// ════════════════════════════════════════════════════════════════════════════

import type { AccessChannel, AccessGrants, ChannelTier, IntegrationLevel } from '@dojo/shared';
import { ACCESS_CHANNELS, cloneGrants, providerLevelOf, stableGrantsText } from '@dojo/shared';

export type Provider = 'google' | 'microsoft';

export interface AccountRow {
  id: string;
  kind: 'agent' | 'user';
  email: string | null;
  connected: boolean;
}

export const clone = (g: AccessGrants): AccessGrants => cloneGrants(g);

// ── Tool groups ──

export const grantsEveryCategory = (g: AccessGrants): boolean => g.tools.categories === '*';

export const categoryChecked = (g: AccessGrants, label: string): boolean =>
  g.tools.categories === '*' || g.tools.categories.includes(label);

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

/** The "every group, including any added later" switch. */
export function setEveryCategory(g: AccessGrants, on: boolean, allLabels: string[]): AccessGrants {
  const next = clone(g);
  next.tools.categories = on ? '*' : [...allLabels];
  return next;
}

// ── Credentials ──

export const grantsEveryCredential = (g: AccessGrants): boolean => g.integrations.credentials === '*';

export const credentialChecked = (g: AccessGrants, service: string): boolean =>
  g.integrations.credentials === '*' || g.integrations.credentials.includes(service);

export function setCredential(g: AccessGrants, service: string, on: boolean, allServices: string[]): AccessGrants {
  const next = clone(g);
  const current = next.integrations.credentials === '*' ? [...allServices] : [...next.integrations.credentials];
  next.integrations.credentials = on
    ? (current.includes(service) ? current : [...current, service])
    : current.filter((s) => s !== service);
  return next;
}

export function setEveryCredential(g: AccessGrants, on: boolean, allServices: string[]): AccessGrants {
  const next = clone(g);
  next.integrations.credentials = on ? '*' : [...allServices];
  return next;
}

// ── Integrations ──

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

/**
 * Set one account's level, and keep the KIND level equal to the widest account
 * of that kind.
 *
 * The second half is not tidiness: the advertised surface filters on the KIND
 * level and the door reads the per-account override, so an account-only edit
 * would leave `gmail_*` on the model's tool list for an agent that is refused at
 * the door — the exact "advertised but not permitted" drift this phase exists to
 * end.
 */
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

// ── Channels ──

export const hasMaster = (g: AccessGrants): boolean => g.channels.master !== null;
export const masterOn = (g: AccessGrants): boolean => g.channels.master === true;

export function setMaster(g: AccessGrants, on: boolean): AccessGrants {
  const next = clone(g);
  next.channels.master = on;
  return next;
}

export function setChannelTier(g: AccessGrants, channel: AccessChannel, tier: ChannelTier): AccessGrants {
  const next = clone(g);
  next.channels[channel] = tier;
  return next;
}

/**
 * Channels this draft grants whose TOOL GROUP it does not — the grant that looks
 * set and does nothing.
 *
 * A2 §6.2 handed this to A3 as a thing the panel must "refuse to let the owner
 * set, or say so on screen". A3 says so on screen, because refusing would mean
 * the panel silently ticking a tool group the owner did not choose. Since the A3
 * rider the call is not merely inert — it is REFUSED at the executor — so the
 * warning names the group to tick.
 */
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

// ── The patch ──

type Patch = Record<string, unknown>;

/**
 * Only what moved, in `grantsPatchSchema`'s shape.
 *
 * An empty object means "nothing to save", which is what the Save button reads.
 * `channels` is omitted entirely for an agent with no master switch, so the
 * ruling holds at the wire and not only in the rendering.
 */
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
  if (moved(original.integrations.credentials, draft.integrations.credentials)) {
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

  // Owner ruling 1: an agent with no master toggle gets no channel section, on
  // the wire as well as on the screen.
  if (hasMaster(draft)) {
    const channels: Patch = {};
    if (original.channels.master !== draft.channels.master) channels.master = draft.channels.master;
    for (const channel of ACCESS_CHANNELS) {
      if (original.channels[channel] !== draft.channels[channel]) channels[channel] = draft.channels[channel];
    }
    if (Object.keys(channels).length > 0) patch.channels = channels;
  }

  return patch;
}

export const isDirty = (original: AccessGrants, draft: AccessGrants): boolean =>
  Object.keys(grantsPatch(original, draft)).length > 0;
