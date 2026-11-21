// THE GRANT DOOR: what a MODEL may hand to another agent. A grants object is
// VALIDATED (a malformed one refuses the call, it never silently defaults),
// must stay inside what the granter HOLDS ITSELF, measured EFFECTIVELY, and
// every excess is NAMED, because a refusal without the field cannot act. The
// three questions copy `agent/scope.ts`, which asks them of the permission manifest.
// Exception: the human-channel master, where only a primary may name
// `channels.master` at all. Excess is judged on the PATCH, not the merged result.

import { z } from 'zod';
import { appendTools } from './tools-policy.js';
import type { AccessGrants, ChannelTier, IntegrationLevel, ProviderGrants } from '@dojo/shared';
import {
  ACCESS_CHANNELS, MOST_RESTRICTIVE_GRANTS, channelTierOf, cloneGrants,
  providerLevelOf, stableGrantsText, techniqueGrantOf,
} from '@dojo/shared';


const LEVELS: readonly IntegrationLevel[] = ['none', 'read', 'full'];
const TIERS: readonly ChannelTier[] = ['none', 'owner', 'all'];

const levelSchema = z.enum(['none', 'read', 'full']);
const tierSchema = z.enum(['none', 'owner', 'all']);
const nameList = z.union([z.literal('*'), z.array(z.string())]);

const providerSchema = z.object({
  agent: levelSchema.optional(),
  user: levelSchema.optional(),
  accounts: z.record(z.string(), levelSchema).optional(),
}).strict();

// Every field optional: this is a patch, and omitted means "leave it alone",
// not "set it to nothing". `.strict()` everywhere: an accepted unknown key is a
// grant the caller believed that never existed. `v` is accepted and ignored so
// a profile read back is not refused when sent straight to an update.
export const grantsPatchSchema = z.object({
  v: z.literal(1).optional(),
  tools: z.object({
    categories: nameList.optional(),
    allow: z.array(z.string()).optional(),
    add: z.array(z.string()).optional(),   // appends to allow (appendTools)
    deny: z.array(z.string()).optional(),
  }).strict().optional(),
  integrations: z.object({
    plaud: z.boolean().optional(),
    // A boolean like plaud; a list or '*' is refused with the field named.
    credentials: z.boolean().optional(),
    google: providerSchema.optional(),
    microsoft: providerSchema.optional(),
  }).strict().optional(),
  channels: z.object({
    master: z.union([z.boolean(), z.null()]).optional(),
    imessage: tierSchema.optional(),
    sms: tierSchema.optional(),
    voice: tierSchema.optional(),
    email: tierSchema.optional(),
    teams: tierSchema.optional(),
  }).strict().optional(),
  // Same nameList shape as categories: the one subset rule covers both.
  techniques: nameList.optional(),
}).strict();

export type GrantsPatch = z.infer<typeof grantsPatchSchema>;

export type GrantsParse =
  | { readonly ok: true; readonly patch: GrantsPatch }
  | { readonly ok: false; readonly reason: string };

/** Returns the refusal reason instead of throwing, so each surface words it itself. */
export function validateGrants(raw: unknown): GrantsParse {
  if (raw === null || raw === undefined) return { ok: false, reason: 'grants is missing' };
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, reason: `grants must be a JSON object, received ${Array.isArray(raw) ? 'an array' : typeof raw}` };
  }
  const parsed = grantsPatchSchema.safeParse(raw);
  if (!parsed.success) {
    return {
      ok: false,
      reason: parsed.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; '),
    };
  }
  return { ok: true, patch: parsed.data };
}


const rank = (v: IntegrationLevel): number => LEVELS.indexOf(v);
const tierRank = (v: ChannelTier): number => TIERS.indexOf(v);

/** Is every name in `child` inside `parent`? `'*'` on the parent holds all. */
function nameSubset(child: string[] | '*', parent: string[] | '*'): { ok: boolean; extra: string[] } {
  if (parent === '*') return { ok: true, extra: [] };
  if (child === '*') return { ok: false, extra: ['*'] };
  const held = new Set(parent);
  const extra = child.filter((n) => !held.has(n));
  return { ok: extra.length === 0, extra };
}

function providerExcesses(
  which: 'google' | 'microsoft',
  child: NonNullable<GrantsPatch['integrations']>['google'],
  held: ProviderGrants,
  out: string[],
): void {
  if (!child) return;
  for (const kind of ['agent', 'user'] as const) {
    const want = child[kind];
    if (want === undefined) continue;
    if (rank(want) > rank(providerLevelOf(held, kind))) {
      out.push(`integrations.${which}.${kind}: cannot grant "${want}" — you hold "${providerLevelOf(held, kind)}"`);
    }
  }
  for (const [accountId, want] of Object.entries(child.accounts ?? {})) {
    // Its own override if held for that account, else the wider of the two kinds.
    const heldForAccount = held.accounts && accountId in held.accounts
      ? held.accounts[accountId]
      : (rank(held.agent) >= rank(held.user) ? held.agent : held.user);
    if (rank(want) > rank(heldForAccount)) {
      out.push(`integrations.${which}.accounts.${accountId}: cannot grant "${want}" — you hold "${heldForAccount}"`);
    }
  }
}

// Every way `patch` EXCEEDS `holder`, named, so the refusal can say which field
// to fix. `tools.deny` is never consulted: a deny only ever narrows.
// `tools.allow` IS, and `allow` RESTRICTS, so an empty allow is the widest one
// and a caller whose own surface is curated cannot mint an uncured child.
export function grantExcesses(
  patch: GrantsPatch,
  holder: AccessGrants,
  granterIsPrimary: boolean,
): string[] {
  const out: string[] = [];

  if (patch.tools?.categories !== undefined) {
    const { ok, extra } = nameSubset(patch.tools.categories, holder.tools.categories);
    if (!ok) {
      out.push(extra[0] === '*'
        ? 'tools.categories: cannot grant every category — your own grant names a bounded list'
        : `tools.categories: cannot grant ${extra.map((c) => `"${c}"`).join(', ')} — you do not hold ${extra.length > 1 ? 'them' : 'it'}`);
    }
  }
  for (const f of ['allow', 'add'] as const) {   // `add` is judged exactly as `allow` is
    const wanted = patch.tools?.[f];
    if (wanted === undefined || holder.tools.allow.length === 0) continue;
    const { extra } = nameSubset(wanted, holder.tools.allow);
    if (f === 'allow' && wanted.length === 0) out.push('tools.allow: cannot grant an unrestricted tool list — your own surface is restricted to a named set');
    else if (extra.length > 0) out.push(`tools.${f}: cannot grant ${extra.map((t) => `"${t}"`).join(', ')} — ${extra.length > 1 ? 'they are' : 'it is'} outside your own tool list`);
  }

  if (patch.integrations?.plaud === true && !holder.integrations.plaud) {
    out.push('integrations.plaud: cannot grant Plaud — you do not hold it');
  }
  // One switch, so the plaud rule: withholding is always allowed, granting what you lack is not.
  if (patch.integrations?.credentials === true && !holder.integrations.credentials) {
    out.push('integrations.credentials: cannot grant access to stored credentials — you do not hold it');
  }
  providerExcesses('google', patch.integrations?.google, holder.integrations.google, out);
  providerExcesses('microsoft', patch.integrations?.microsoft, holder.integrations.microsoft, out);

  // The identity rule, checked before the tiers so its message reads first.
  if (patch.channels?.master !== undefined && !granterIsPrimary) {
    out.push('channels.master: only the primary agent may set another agent\'s "allowed to talk to humans" switch');
  }
  for (const channel of ACCESS_CHANNELS) {
    const want = patch.channels?.[channel];
    if (want === undefined) continue;
    // EFFECTIVE tier: channelTierOf applies the master switch, so a master-off granter holds nothing.
    const heldTier = channelTierOf(holder, channel);
    if (tierRank(want) > tierRank(heldTier)) {
      out.push(`channels.${channel}: cannot grant "${want}" — you hold "${heldTier}" on that channel`);
    }
  }

  if (patch.techniques !== undefined) {
    const { ok, extra } = nameSubset(patch.techniques, techniqueGrantOf(holder));
    if (!ok) {
      out.push(extra[0] === '*'
        ? 'techniques: cannot grant every technique — your own grant names a bounded list'
        : `techniques: cannot grant ${extra.map((t) => `"${t}"`).join(', ')} — ${extra.length > 1 ? 'they are' : 'it is'} not in your technique grant`);
    }
  }

  return out;
}


/** `patch` over `base`, field by field. An omitted field keeps the base's. */
export function mergeGrants(base: AccessGrants, patch: GrantsPatch): AccessGrants {
  const g = cloneGrants(base);
  if (patch.tools) {
    if (patch.tools.categories !== undefined) g.tools.categories = patch.tools.categories;
    if (patch.tools.allow !== undefined) g.tools.allow = [...patch.tools.allow];
    if (patch.tools.add !== undefined) g.tools.allow = appendTools(g.tools.allow, patch.tools.add);
    if (patch.tools.deny !== undefined) g.tools.deny = [...patch.tools.deny];
  }
  if (patch.integrations) {
    const i = patch.integrations;
    if (i.plaud !== undefined) g.integrations.plaud = i.plaud;
    if (i.credentials !== undefined) g.integrations.credentials = i.credentials;
    for (const which of ['google', 'microsoft'] as const) {
      const p = i[which];
      if (!p) continue;
      if (p.agent !== undefined) g.integrations[which].agent = p.agent;
      if (p.user !== undefined) g.integrations[which].user = p.user;
      if (p.accounts !== undefined) g.integrations[which].accounts = { ...p.accounts };
    }
  }
  if (patch.channels) {
    if (patch.channels.master !== undefined) g.channels.master = patch.channels.master;
    for (const channel of ACCESS_CHANNELS) {
      const want = patch.channels[channel];
      if (want !== undefined) g.channels[channel] = want;
    }
  }
  if (patch.techniques !== undefined) {
    g.techniques = patch.techniques === '*' ? '*' : [...patch.techniques];
  }
  return g;
}

// Narrow `grants` so it cannot exceed `holder` anywhere. Applied ONLY to the
// DEFAULT: a default may be narrowed silently because nobody asked for it, a
// named value may not, because a silent downgrade is how an agent ends up with
// a scope nobody chose. A child must not inherit a floor its parent is not on.
export function clampGrantsTo(grants: AccessGrants, holder: AccessGrants): AccessGrants {
  const g = cloneGrants(grants);
  if (holder.tools.categories !== '*') {
    const held = new Set(holder.tools.categories);
    g.tools.categories = g.tools.categories === '*'
      ? [...holder.tools.categories]
      : g.tools.categories.filter((c) => held.has(c));
  }
  if (holder.tools.allow.length > 0 && g.tools.allow.length === 0) {
    g.tools.allow = [...holder.tools.allow];
  }
  if (!holder.integrations.plaud) g.integrations.plaud = false;
  if (!holder.integrations.credentials) g.integrations.credentials = false;
  for (const which of ['google', 'microsoft'] as const) {
    for (const kind of ['agent', 'user'] as const) {
      const cap = providerLevelOf(holder.integrations[which], kind);
      if (rank(g.integrations[which][kind]) > rank(cap)) g.integrations[which][kind] = cap;
    }
  }
  for (const channel of ACCESS_CHANNELS) {
    const cap = channelTierOf(holder, channel);
    if (tierRank(g.channels[channel]) > tierRank(cap)) g.channels[channel] = cap;
  }
  const heldTechniques = techniqueGrantOf(holder);
  if (heldTechniques !== '*') {
    const held = new Set(heldTechniques);
    const mine = techniqueGrantOf(g);
    g.techniques = mine === '*' ? [...heldTechniques] : mine.filter((t) => held.has(t));
  }
  return g;
}


export type GrantsResolution =
  | { readonly ok: true; readonly grants: AccessGrants }
  | { readonly ok: false; readonly reason: string };

// A spawn refused for ACCESS reasons, as a type: the handler must tell a grant
// refusal from a database error to write the audit row and give the model the
// plain reason, so the class carries the fact instead of sniffing message text.
export class GrantRefusedError extends Error {
  constructor(public readonly plainReason: string) {
    super(`Spawn denied: ${plainReason}`);
    this.name = 'GrantRefusedError';
  }
}

const refusal = (excesses: string[]): string =>
  `An agent can only grant access it holds itself — ${excesses.join('; ')}.`;

// THE SPAWN DOOR. No grants named: the most restrictive default, clamped to the
// granter. Grants named: validated, bounded by no-escalation, merged OVER that
// base, so an omitted field falls to the floor and never to the granter's own
// holdings; an agent's named tool groups add to the floor, the owner's replace it. `defaults` exists because the dashboard create route passes its own
// base; `granter` null is the OWNER, capped by no agent. `toolsPolicy` is
// `spawn_agent`'s legacy tools argument, folded in verbatim and NOT judged by
// no-escalation: it must keep working, and judging it would invent a refusal.
export function resolveSpawnGrants(
  requested: unknown,
  granter: AccessGrants | null,
  granterIsPrimary: boolean,
  toolsPolicy?: { allow?: string[]; deny?: string[] } | null,
  defaults: AccessGrants = MOST_RESTRICTIVE_GRANTS,
): GrantsResolution {
  const base = granter ? clampGrantsTo(defaults, granter) : cloneGrants(defaults);
  let resolved = base;
  if (requested !== undefined && requested !== null) {
    const validated = validateGrants(requested);
    if (!validated.ok) return { ok: false, reason: `invalid grants — ${validated.reason}` };
    const excesses = granter ? grantExcesses(validated.patch, granter, granterIsPrimary) : [];
    if (excesses.length > 0) return { ok: false, reason: refusal(excesses) };
    resolved = mergeGrants(base, validated.patch);
    const [floor, named] = [base.tools.categories, resolved.tools.categories];
    if (granter && floor !== '*' && named !== '*') resolved.tools.categories = [...new Set([...floor, ...named])];
  }
  if (toolsPolicy) {
    resolved = cloneGrants(resolved);
    if (Array.isArray(toolsPolicy.allow)) resolved.tools.allow = [...toolsPolicy.allow];
    if (Array.isArray(toolsPolicy.deny)) resolved.tools.deny = [...toolsPolicy.deny];
  }
  return { ok: true, grants: resolved };
}

/** THE EDIT DOOR. The patch merges over the TARGET's current object; no escalation judges the PATCH
 *  against an AGENT granter. `granter` null is the OWNER: never bounded by an agent's grants. */
export function resolveUpdateGrants(
  requested: unknown,
  current: AccessGrants,
  granter: AccessGrants | null,
  granterIsPrimary: boolean,
): GrantsResolution {
  const validated = validateGrants(requested);
  if (!validated.ok) return { ok: false, reason: `invalid grants — ${validated.reason}` };
  const excesses = granter ? grantExcesses(validated.patch, granter, granterIsPrimary) : [];
  if (excesses.length > 0) return { ok: false, reason: refusal(excesses) };
  return { ok: true, grants: mergeGrants(current, validated.patch) };
}


/** Every leaf that moved, as `section.field: before → after`. Empty when the two
 *  objects say the same thing, which is what makes "no change, no audit row"
 *  decidable rather than a judgement call at each call site. */
export function grantsDelta(before: AccessGrants, after: AccessGrants): string {
  const rows: string[] = [];
  const cmp = (label: string, a: unknown, b: unknown): void => {
    const at = stableGrantsText(a);
    const bt = stableGrantsText(b);
    if (at !== bt) rows.push(`${label}: ${at} → ${bt}`);
  };
  cmp('tools.categories', before.tools.categories, after.tools.categories);
  cmp('tools.allow', before.tools.allow, after.tools.allow);
  cmp('tools.deny', before.tools.deny, after.tools.deny);
  cmp('integrations.plaud', before.integrations.plaud, after.integrations.plaud);
  cmp('integrations.credentials', before.integrations.credentials, after.integrations.credentials);
  for (const which of ['google', 'microsoft'] as const) {
    cmp(`integrations.${which}`, before.integrations[which], after.integrations[which]);
  }
  cmp('channels.master', before.channels.master, after.channels.master);
  for (const channel of ACCESS_CHANNELS) {
    cmp(`channels.${channel}`, before.channels[channel], after.channels[channel]);
  }
  // Through `techniqueGrantOf` on both sides, so a stored object missing the key
  // compares as the `'*'` it means and a no-op edit stays a no-op.
  cmp('techniques', techniqueGrantOf(before), techniqueGrantOf(after));
  return rows.join('; ');
}

// One reader, one writer: the stored object is read beside the derivation it
// must not be confused with, and written beside the permissions-document merge.
