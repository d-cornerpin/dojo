// ════════════════════════════════════════════════════════════════════════════
// THE ACCESS GRANTS — one object per agent (UX-ACCESS A1).
//
// The census (task-W72-report §0) found SIX unrelated gating mechanisms and only
// three of them took an agent id at all. Channels were a role singleton
// (`isPrimaryAgent`), integrations were global flags, credentials were keyed by
// nothing, and the only per-agent tool lever was a DENY list. This is the one
// object that replaces the scatter: what an agent may reach, stated positively,
// in the shape the owner edits.
//
// ── WHERE IT LIVES, AND WHY NOT IN A NEW TABLE ──
// Inside `agents.permissions`, the JSON blob that already carries the per-agent
// `PermissionManifest`. A second store would be a second truth, and the phase
// that this repo exists to end is the one where a fact is derived in two places.
// `grant_rule` keeps doing exactly the job it already does — the derived cache
// of the manifest's EFFECT kinds — and is not asked to carry these sections:
// authoring policy in that table is impossible by construction (its only writer
// is its own reader, re-projecting on every fingerprint mismatch).
//
// ── THE ÜBER TOGGLE (owner ruling 1, 2026-09-13) ──
// `channels.master` is "allowed to talk to humans". Every per-channel grant sits
// BENEATH it and is inert unless it is `true` — which is why `channelTierOf()`
// below is the only legal way to read one. `null` means the agent has no such
// toggle at all: a sensei agent other than the primary communicates THROUGH the
// main agent, which is today's architecture and is kept.
//
// This module is PURE — no database, no platform identity, no imports. The
// derivation that turns an agent's current effective access into one of these
// lives in `server/src/agent/access/derive.ts`; the readers are in `read.ts`.
// ════════════════════════════════════════════════════════════════════════════

/** Every outbound human channel the platform has a door for. */
export const ACCESS_CHANNELS = ['imessage', 'sms', 'voice', 'email', 'teams'] as const;
export type AccessChannel = (typeof ACCESS_CHANNELS)[number];

/**
 * The me-vs-other-people tier (owner ruling 1's "and me-vs-other-people tiers").
 *   `none`   the channel is not granted.
 *   `owner`  only the human marked `is_primary` on that channel's safe-sender
 *            list — the owner — may be reached.
 *   `all`    every approved recipient on that channel.
 */
export type ChannelTier = 'none' | 'owner' | 'all';

/** The Workspace access tier, per provider and per account kind. */
export type IntegrationLevel = 'none' | 'read' | 'full';

/** `google_accounts.kind` / `microsoft_accounts.kind` — the work-vs-personal split. */
export type AccountKind = 'agent' | 'user';

export interface ChannelGrants {
  /**
   * THE MASTER SWITCH. `true` = may talk to humans, `false` = may not,
   * `null` = has no such toggle (sensei, other than the primary).
   * A `null` master is NOT "on": `channelTierOf` answers `none` for it.
   */
  master: boolean | null;
  imessage: ChannelTier;
  sms: ChannelTier;
  voice: ChannelTier;
  email: ChannelTier;
  teams: ChannelTier;
}

/**
 * One provider's grants. `agent` / `user` are the two account KINDS, which is
 * where the work-vs-personal split lives on every box today. `accounts` is the
 * per-ACCOUNT override for a box that connected more than one account on a kind
 * (up to five per kind) — absent means "the kind's level governs", which is what
 * every migrated agent carries.
 */
export interface ProviderGrants {
  agent: IntegrationLevel;
  user: IntegrationLevel;
  accounts?: Record<string, IntegrationLevel>;
}

export interface IntegrationGrants {
  /** Plaud is one global connect flag today; this is the per-agent half. */
  plaud: boolean;
  /** Credential service names this agent may read/write/delete. `'*'` = all. */
  credentials: string[] | '*';
  google: ProviderGrants;
  microsoft: ProviderGrants;
}

export interface ToolGrants {
  /** POSITIVE grant by `TOOL_CATEGORIES` label. `'*'` = every category. */
  categories: string[] | '*';
  /** The curated surface restriction (what `tools_policy.allow` meant). */
  allow: string[];
  /** Deny wins over everything, at the surface AND at the executor. */
  deny: string[];
}

export interface AccessGrants {
  /** Schema version. One value today; a future shape migrates on this. */
  v: 1;
  tools: ToolGrants;
  integrations: IntegrationGrants;
  channels: ChannelGrants;
}

// ── Readers. Every consumer goes through these, so the master-switch rule and
//    the account-override rule cannot be re-implemented anywhere. ──

/**
 * The tier this agent actually holds on `channel`.
 *
 * The master switch is applied HERE and only here: a per-channel value of
 * `'all'` under a `false` or `null` master answers `'none'`. That is owner
 * ruling 1's "inert unless the master is on" as a property of the reader rather
 * than of anybody's discipline at the call site.
 */
export function channelTierOf(grants: AccessGrants, channel: AccessChannel): ChannelTier {
  if (grants.channels.master !== true) return 'none';
  return grants.channels[channel] ?? 'none';
}

/** May this agent reach a human on `channel` at all? */
export function mayReachChannel(grants: AccessGrants, channel: AccessChannel): boolean {
  return channelTierOf(grants, channel) !== 'none';
}

/** May this agent reach a NON-owner recipient on `channel`? */
export function mayReachOthersOn(grants: AccessGrants, channel: AccessChannel): boolean {
  return channelTierOf(grants, channel) === 'all';
}

/** The level for one account: the per-account override, else the kind's level. */
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

/** May this agent touch the credential stored under `serviceName`? */
export function mayTouchCredentialIn(grants: AccessGrants, serviceName: string): boolean {
  const c = grants.integrations.credentials;
  return c === '*' || c.includes(serviceName);
}

/** Does this agent hold ANY credential grant (i.e. is the vault reachable)? */
export function holdsAnyCredentialGrant(grants: AccessGrants): boolean {
  const c = grants.integrations.credentials;
  return c === '*' || c.length > 0;
}

/** Is this `TOOL_CATEGORIES` label granted? Uncategorized tools are never here. */
export function categoryGranted(grants: AccessGrants, label: string): boolean {
  const cats = grants.tools.categories;
  return cats === '*' || cats.includes(label);
}

/**
 * MOST RESTRICTIVE (owner ruling 2): files + scratchpad only, no channels, no
 * integrations, no credentials.
 *
 * NOT the default for agents created today — applying it in A1 would narrow
 * every sub-agent the platform spawns, and A1's bar is byte-equivalence. It is
 * the shape A2's `spawn_agent`/`update_agent` grant arguments start FROM, and
 * it is exported here so the two phases cannot write two versions of "most
 * restrictive".
 */
export const MOST_RESTRICTIVE_GRANTS: AccessGrants = {
  v: 1,
  tools: { categories: ['Meta', 'File & System'], allow: [], deny: [] },
  integrations: {
    plaud: false,
    credentials: [],
    google: { agent: 'none', user: 'none' },
    microsoft: { agent: 'none', user: 'none' },
  },
  channels: { master: false, imessage: 'none', sms: 'none', voice: 'none', email: 'none', teams: 'none' },
};

/** Deep structural copy — grants are stored, edited and diffed, never aliased. */
export function cloneGrants(g: AccessGrants): AccessGrants {
  return JSON.parse(JSON.stringify(g)) as AccessGrants;
}

/**
 * Stable text for one grants object: keys sorted at every depth, so two objects
 * that say the same thing produce the same string. This is what a before/after
 * capability diff compares and what a fingerprint hashes.
 */
export function stableGrantsText(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(stableGrantsText).join(',')}]`;
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableGrantsText(obj[k])}`).join(',')}}`;
}
