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
import { ACCESS_CHANNELS, cloneGrants, providerLevelOf, stableGrantsText, techniqueGrantOf } from '@dojo/shared';

export type Provider = 'google' | 'microsoft';

export interface AccountRow {
  id: string;
  kind: 'agent' | 'user';
  email: string | null;
  connected: boolean;
}

export const clone = (g: AccessGrants): AccessGrants => cloneGrants(g);

// ── Tool groups (UX-ACCESS A5: a MODE, not a checkbox) ──
//
// Owner order: the section offers "Full tool access" or "Individual tool
// access", and the 38 group checkboxes render only under the second. The model
// is unchanged and the mapping is exact — `'*'` IS the full mode, which is why
// all 111 migrated agents read "Full" and the capability diff stays empty.

export type ToolMode = 'full' | 'individual';

export const toolMode = (g: AccessGrants): ToolMode =>
  g.tools.categories === '*' ? 'full' : 'individual';

export const categoryChecked = (g: AccessGrants, label: string): boolean =>
  g.tools.categories === '*' || g.tools.categories.includes(label);

/**
 * Switch the mode.
 *
 * FULL → INDIVIDUAL EXPANDS, it does not blank. `'*'` means "every group,
 * including ones added later", so the honest starting point for a bounded list
 * is today's whole list — and writing `[]` here would strip every tool the agent
 * holds the moment the owner so much as looked at the control. Nothing is saved
 * until Save either way, so a mode flip the owner reverses costs nothing.
 */
export function setToolMode(g: AccessGrants, mode: ToolMode, allLabels: string[]): AccessGrants {
  const next = clone(g);
  next.tools.categories = mode === 'full'
    ? '*'
    : (next.tools.categories === '*' ? [...allLabels] : [...next.tools.categories]);
  return next;
}

// ── Techniques (UX-ACCESS A4; A5 makes it a switch over a list) ──
//
// The SAME `'*'`-is-a-promise rule as the tool groups, and for the same reason:
// unticking one technique under `'*'` must not silently keep a grant for a
// technique the Trainer publishes next week. `techniqueGrantOf` is what makes a
// row written before A4 (no `techniques` key) read as the `'*'` it means.
//
// A5, owner order: a "Technique access" switch, with the list beneath it and all
// of it checked when the switch goes on. "On" is therefore exactly "holds any
// grant", and turning it on writes `'*'` — the promise, which is what "all
// checked, including ones published later" means in this model.

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

// ── Credentials (UX-ACCESS A5) ──
//
// ⚰ THE PER-CREDENTIAL ROWS ARE GONE, and so is the math behind them
// (`grantsEveryCredential` / `credentialChecked` / `setCredential` /
// `setEveryCredential`). Owner order: one toggle, "Access to stored
// credentials". The MODEL moved with it — `integrations.credentials` is a
// boolean now — so this is two lines rather than four functions, and there is no
// finer reading of the field left anywhere for the toggle to be lying about.

export const credentialsGranted = (g: AccessGrants): boolean => g.integrations.credentials;

export function setCredentials(g: AccessGrants, on: boolean): AccessGrants {
  const next = clone(g);
  next.integrations.credentials = on;
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

/**
 * The über toggle, which now REVEALS its children rather than dimming them
 * (owner order, UX-ACCESS A5).
 *
 * TURNING IT ON DEFAULTS EVERY CHANNEL TO `'owner'` — "Only me" — and never to
 * `'all'`. The master is a statement that this agent may talk to people; it is
 * not a statement about WHICH people, and owner ruling 1's me-vs-other-people
 * tier is the place that second decision lives. So reaching anyone other than
 * the owner stays a deliberate extra click, per channel.
 *
 * THE DEFAULT ONLY FIRES WHEN THERE IS NOTHING TO RESTORE. A3 made the
 * per-channel value survive a `false` master on purpose (`channelTierOf` applies
 * the master, so a stored tier is inert rather than erased); this is what that
 * property buys. An owner who narrows the children, flips the master off to look
 * at something and flips it back gets HIS set back, not a fresh sweep of
 * defaults over it. Turning the master OFF never touches a child.
 */
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
  // A5: a boolean, compared exactly like the Plaud switch above it.
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

  // A4: compared through `techniqueGrantOf` on BOTH sides, so opening the panel
  // on a pre-A4 row and pressing Save without touching the section sends
  // nothing — the absence and the `'*'` it means are the same value here.
  if (moved(techniqueGrantOf(original), techniqueGrantOf(draft))) {
    patch.techniques = techniqueGrantOf(draft);
  }

  return patch;
}

export const isDirty = (original: AccessGrants, draft: AccessGrants): boolean =>
  Object.keys(grantsPatch(original, draft)).length > 0;
