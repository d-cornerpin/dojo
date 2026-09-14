// ════════════════════════════════════════════════════════════════════════════
// THE GRANT DOOR (UX-ACCESS A2, owner ruling 4) — what a MODEL may hand out.
//
// A1 built the walls and proved they refuse. What it could not build was the
// door: `spawn_agent` and `update_agent` could hand a child a permission
// MANIFEST and a tool-name policy and nothing else, so there was no way for the
// primary to give a sub-agent a category, an integration, a credential or a
// channel — and that is exactly why ruling 2's most-restrictive default could
// not land in A1 (§6.1). A default that narrows with no door to widen through
// is a platform that cannot delegate.
//
// ── THIS IS `scope.ts` FOR GRANTS, AND DELIBERATELY SO ──
// `agent/scope.ts` already answers the same three questions for the permission
// MANIFEST — validated, subset-of-parent, refuse-rather-than-downgrade — and
// its shape is copied here on purpose rather than re-invented:
//
//   VALIDATED   a supplied grants object is checked against a schema, and a
//               MALFORMED one REFUSES the call rather than silently becoming
//               the default. A silent downgrade is how an agent ends up with a
//               scope nobody chose.
//   SUBSET      NO ESCALATION. An agent may grant only what it itself holds,
//               measured against its EFFECTIVE grants — so a granter whose
//               human-channel master is off holds `none` on every channel and
//               can therefore grant no channel, without that rule being
//               written down twice (`channelTierOf` already applies it).
//   REFUSE      every excess is NAMED, because "permission denied" with no
//               field is a message a model cannot act on.
//
// ── THE ONE RULE THAT IS NOT A SUBSET RULE ──
// The human-channel MASTER. Owner ruling 4: *"the human-channel master on a
// spawned agent may be set by the primary (owner's explicit intent) but never
// by a non-primary."* That is an identity rule, not a holdings rule: an
// `operator` agent that legitimately holds `master:true` and `imessage:'all'`
// still may not mint a second agent that talks to humans. It is taken
// literally — a non-primary naming `channels.master` at all is refused, in
// either direction — because "never set it" is the least ambiguous reading and
// it is the safe one. A non-primary that wants to withhold a channel withholds
// the CHANNEL, which it may.
//
// ── WHY THE EXCESS CHECK READS THE PATCH AND NOT THE RESULT ──
// `update_agent` merges over the TARGET's current object. A target that already
// holds `categories:'*'` and the credential switch from the A1 migration is not
// something the caller granted, and refusing an unrelated edit because of it
// would make the door unusable on exactly the agents the owner most wants to
// narrow. So the check reads what the CALLER asked for.
// ════════════════════════════════════════════════════════════════════════════

import { z } from 'zod';
import type { AccessGrants, ChannelTier, IntegrationLevel, ProviderGrants } from '@dojo/shared';
import {
  ACCESS_CHANNELS, MOST_RESTRICTIVE_GRANTS, channelTierOf, cloneGrants,
  providerLevelOf, stableGrantsText, techniqueGrantOf,
} from '@dojo/shared';

// ── The schema ──

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

/**
 * A PARTIAL grants object — every section and every field optional, because the
 * argument is a patch and an omitted field must mean "leave it alone" rather
 * than "set it to nothing". `.strict()` everywhere: an unknown key is a typo or
 * a hallucinated field, and accepting it silently is how a grant the caller
 * believed it set turns out never to have existed.
 *
 * `v` is accepted and ignored. A model that read an agent's grants back through
 * `get_agent_profile` and sent the object straight to `update_agent` carries it,
 * and refusing that round trip would be a schema teaching nothing.
 */
export const grantsPatchSchema = z.object({
  v: z.literal(1).optional(),
  tools: z.object({
    categories: nameList.optional(),
    allow: z.array(z.string()).optional(),
    deny: z.array(z.string()).optional(),
  }).strict().optional(),
  integrations: z.object({
    plaud: z.boolean().optional(),
    // UX-ACCESS A5 — a BOOLEAN, the same shape as `plaud` above it. A model that
    // sends A1's `'*'` or a list of service names is REFUSED with the field
    // named, which is the schema teaching the shape rather than silently
    // accepting a grant the caller believed it made.
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
  // UX-ACCESS A4 — the fourth section. Same `nameList` shape as `categories`
  // and `credentials`, so `nameSubset` already answers the no-escalation
  // question for it and there is one subset rule in this file, not three.
  techniques: nameList.optional(),
}).strict();

export type GrantsPatch = z.infer<typeof grantsPatchSchema>;

export type GrantsParse =
  | { readonly ok: true; readonly patch: GrantsPatch }
  | { readonly ok: false; readonly reason: string };

/** Validate a grants patch that arrived as an OBJECT (a tool argument, an API
 *  body). Returns the reason rather than throwing, so each surface decides what
 *  a refusal looks like — a tool result, a 400, a log line. */
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

// ── No escalation ──

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
    // The holder's level for THAT account: its own override if it has one, else
    // the widest of the two kinds — the same question `providerLevelOf` answers,
    // asked without knowing which kind the account is filed under.
    const heldForAccount = held.accounts && accountId in held.accounts
      ? held.accounts[accountId]
      : (rank(held.agent) >= rank(held.user) ? held.agent : held.user);
    if (rank(want) > rank(heldForAccount)) {
      out.push(`integrations.${which}.accounts.${accountId}: cannot grant "${want}" — you hold "${heldForAccount}"`);
    }
  }
}

/**
 * EVERY WAY `patch` EXCEEDS `holder`, named.
 *
 * A list rather than a boolean for the same reason `scopeExcesses` is one: the
 * refusal has to tell the caller which field to fix.
 *
 * `tools.deny` is never consulted — a deny only ever narrows, and refusing an
 * agent the right to withhold something would be a rule with no victim.
 * `tools.allow` IS consulted, and in the direction the census (C2) recorded:
 * `allow` RESTRICTS, so an empty allow is the widest one, and a caller whose own
 * surface is curated cannot mint a child with no curation at all.
 */
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
  if (patch.tools?.allow !== undefined && holder.tools.allow.length > 0) {
    const wanted = patch.tools.allow;
    const { ok, extra } = nameSubset(wanted, holder.tools.allow);
    if (wanted.length === 0) {
      out.push('tools.allow: cannot grant an unrestricted tool list — your own surface is restricted to a named set');
    } else if (!ok) {
      out.push(`tools.allow: cannot grant ${extra.map((t) => `"${t}"`).join(', ')} — ${extra.length > 1 ? 'they are' : 'it is'} outside your own tool list`);
    }
  }

  if (patch.integrations?.plaud === true && !holder.integrations.plaud) {
    out.push('integrations.plaud: cannot grant Plaud — you do not hold it');
  }
  // UX-ACCESS A5: one switch, so one rule — the same one Plaud gets above.
  // Withholding is always allowed; only granting what you do not hold is not.
  if (patch.integrations?.credentials === true && !holder.integrations.credentials) {
    out.push('integrations.credentials: cannot grant access to stored credentials — you do not hold it');
  }
  providerExcesses('google', patch.integrations?.google, holder.integrations.google, out);
  providerExcesses('microsoft', patch.integrations?.microsoft, holder.integrations.microsoft, out);

  // THE IDENTITY RULE, and it is checked before the tiers so its message is the
  // one the caller reads first.
  if (patch.channels?.master !== undefined && !granterIsPrimary) {
    out.push('channels.master: only the primary agent may set another agent\'s "allowed to talk to humans" switch');
  }
  for (const channel of ACCESS_CHANNELS) {
    const want = patch.channels?.[channel];
    if (want === undefined) continue;
    // The holder's EFFECTIVE tier — `channelTierOf` applies the master switch,
    // so an agent whose master is off holds nothing to hand on.
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

// ── Merging and clamping ──

/** `patch` over `base`, field by field. An omitted field keeps the base's. */
export function mergeGrants(base: AccessGrants, patch: GrantsPatch): AccessGrants {
  const g = cloneGrants(base);
  if (patch.tools) {
    if (patch.tools.categories !== undefined) g.tools.categories = patch.tools.categories;
    if (patch.tools.allow !== undefined) g.tools.allow = [...patch.tools.allow];
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

/**
 * Narrow `grants` so it cannot exceed `holder` anywhere.
 *
 * Applied ONLY to the DEFAULT — never to anything a caller named, which is
 * refused instead (the same asymmetry `resolveChildScope` draws: a default may
 * be narrowed silently because nobody asked for it; a named value may not,
 * because a silent downgrade is how an agent ends up with a scope nobody chose).
 * It matters the moment A3's panel exists and a granter is itself narrowed: a
 * child must not inherit a floor its parent does not stand on.
 */
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

// ── The two entry points a tool uses ──

export type GrantsResolution =
  | { readonly ok: true; readonly grants: AccessGrants }
  | { readonly ok: false; readonly reason: string };

/**
 * A spawn refused for ACCESS reasons, as a type rather than a message.
 *
 * `spawnAgent` signals every refusal by throwing, and its tool handler has to
 * tell a grant refusal apart from a database error so it can write the audit row
 * ruling 4 requires and hand the model the plain reason instead of
 * `friendlyDbError`'s translation. Sniffing the message text would be exactly
 * the prose-keying this overhaul deletes, so the class carries the fact.
 */
export class GrantRefusedError extends Error {
  constructor(public readonly plainReason: string) {
    super(`Spawn denied: ${plainReason}`);
    this.name = 'GrantRefusedError';
  }
}

const refusal = (excesses: string[]): string =>
  `An agent can only grant access it holds itself — ${excesses.join('; ')}.`;

/**
 * THE SPAWN DOOR.
 *
 * No grants named → owner ruling 2's MOST RESTRICTIVE object, clamped to the
 * granter. Grants named → schema-validated, bounded by the no-escalation rule,
 * and merged OVER that restrictive base, so a field the caller left out falls
 * back to the floor rather than to the granter's own holdings. Omitting a field
 * can never be a way to inherit access.
 *
 * `toolsPolicy` is `spawn_agent`'s PRE-A2 `tools:{allow,deny}` argument, folded
 * in verbatim and deliberately NOT subject to the no-escalation rule. A1 made
 * the grants object the authority for what the `tools_policy` column used to
 * say, so a spawn that stores grants must carry that argument into them or it
 * silently stops working — and judging it would invent a refusal for a call that
 * works today.
 */
export function resolveSpawnGrants(
  requested: unknown,
  granter: AccessGrants,
  granterIsPrimary: boolean,
  toolsPolicy?: { allow?: string[]; deny?: string[] } | null,
): GrantsResolution {
  const base = clampGrantsTo(MOST_RESTRICTIVE_GRANTS, granter);
  let resolved = base;
  if (requested !== undefined && requested !== null) {
    const validated = validateGrants(requested);
    if (!validated.ok) return { ok: false, reason: `invalid grants — ${validated.reason}` };
    const excesses = grantExcesses(validated.patch, granter, granterIsPrimary);
    if (excesses.length > 0) return { ok: false, reason: refusal(excesses) };
    resolved = mergeGrants(base, validated.patch);
  }
  if (toolsPolicy) {
    resolved = cloneGrants(resolved);
    if (Array.isArray(toolsPolicy.allow)) resolved.tools.allow = [...toolsPolicy.allow];
    if (Array.isArray(toolsPolicy.deny)) resolved.tools.deny = [...toolsPolicy.deny];
  }
  return { ok: true, grants: resolved };
}

/** THE EDIT DOOR. The patch merges over the TARGET's current object; the
 *  no-escalation rule judges the PATCH (see the header). */
export function resolveUpdateGrants(
  requested: unknown,
  current: AccessGrants,
  granter: AccessGrants,
  granterIsPrimary: boolean,
): GrantsResolution {
  const validated = validateGrants(requested);
  if (!validated.ok) return { ok: false, reason: `invalid grants — ${validated.reason}` };
  const excesses = grantExcesses(validated.patch, granter, granterIsPrimary);
  if (excesses.length > 0) return { ok: false, reason: refusal(excesses) };
  return { ok: true, grants: mergeGrants(current, validated.patch) };
}

// ── The audit delta ──

/** Every leaf that moved, as `section.field: before → after`. Empty when the two
 *  objects say the same thing — which is what makes "no change, no audit row"
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
  // Through `techniqueGrantOf` on both sides, so an object written before A4
  // (no key) compares as the `'*'` it means and a no-op edit stays a no-op.
  cmp('techniques', techniqueGrantOf(before), techniqueGrantOf(after));
  return rows.join('; ');
}

// Reading and writing the stored object are NOT here, deliberately.
// `readStoredGrants` lives beside the derivation it must not be confused with
// (`access/read.ts`) and `writeGrants` beside the migration that already merged
// grants into the `permissions` DOCUMENT (`access/materialize.ts`), which is now
// its only other caller. One reader, one writer; this module decides only what
// may be written.
