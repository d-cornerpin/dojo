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
  /**
   * MAY THIS AGENT REACH THE CREDENTIAL STORE AT ALL? (owner order, UX-ACCESS A5.)
   *
   * A1 declared this as `string[] | '*'` — a per-service allow-list. The owner's
   * ruling is that the honest shape is all-or-none, and the measurement agrees:
   * across the 113 stored rows on the owner's box the value was `'*'` on 111 and
   * `[]` on the two A4 exemplars. **Nothing had ever named a subset**, and
   * nothing could: `derive.ts` answers `'*'` and only `'*'`.
   *
   * So the field is the same kind of switch `plaud` beside it already is, read
   * the same way (directly — there is no helper, because there is no rule to
   * hide), and the per-name reader is deleted rather than left with one caller.
   * A second, finer reading of a field the panel draws as one toggle is exactly
   * the drift this overhaul exists to end.
   *
   * The migration is `foldCredentialGrant`, applied at the one read boundary.
   */
  credentials: boolean;
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
  /**
   * THE FOURTH SECTION (UX-ACCESS A4) — which techniques this agent may run.
   * `'*'` = every published technique, which is what every agent alive before
   * A4 held (nothing anywhere asked). Technique IDs, the same strings
   * `agents.equipped_techniques` stores.
   *
   * ── WHY THIS IS A GRANT AND `equipped_techniques` IS NOT ──
   * They answer different questions and the census found only one of them
   * wired: `equipped_techniques` is a PRE-LOAD list (inline these bodies into
   * the prompt), and it was never consulted by any access decision. The grant is
   * the access decision, and it governs all four places a technique reaches an
   * agent: the published index it is advertised in, the matcher that injects a
   * body unasked, the `use_technique` / `technique_read` door, and the equipped
   * pre-load. Equipping something ungranted therefore loads nothing rather than
   * quietly widening the grant.
   *
   * OPTIONAL ON THE WIRE, and that is the migration. A1 materialized 111 rows
   * with three sections; a reader that demanded a fourth would have thrown every
   * one of them back to the derivation. `techniqueGrantOf` reads an absent
   * section as `'*'` — the pre-A4 fact — so no stored row has to be rewritten.
   */
  techniques?: string[] | '*';
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

/**
 * A STORED credential grant, read as the boolean it now is (UX-ACCESS A5).
 *
 * This is the whole migration, and it is a READER rule so that no row is
 * rewritten and no DDL runs — the same shape A4's `techniqueGrantOf` used for
 * an absent section.
 *
 *   `'*'`            → true    the value all 111 live agents carry
 *   `[]`             → false   the value A4's two exemplars carry
 *   a non-empty list → true    holding one name was already holding the vault:
 *                              the surface strip and the `credential_list` door
 *                              both answered yes for such an agent. **No row on
 *                              the owner's box is in this state and none can be
 *                              produced by `derive.ts`**, so the case is
 *                              answered here rather than left to a cast.
 *   anything else    → false   a malformed field never widens.
 */
export function foldCredentialGrant(stored: unknown): boolean {
  if (typeof stored === 'boolean') return stored;
  if (stored === '*') return true;
  if (Array.isArray(stored)) return stored.length > 0;
  return false;
}

/** Is this `TOOL_CATEGORIES` label granted? Uncategorized tools are never here. */
export function categoryGranted(grants: AccessGrants, label: string): boolean {
  const cats = grants.tools.categories;
  return cats === '*' || cats.includes(label);
}

/**
 * The technique grant, with the ABSENT case answered once (UX-ACCESS A4).
 *
 * A stored object written before A4 carries no `techniques` key, and the honest
 * reading of that absence is the fact that was true when it was written: every
 * published technique was reachable by every agent. Answering `[]` instead would
 * silently strip 111 rows the moment this code shipped.
 */
export function techniqueGrantOf(grants: AccessGrants): string[] | '*' {
  return grants.techniques ?? '*';
}

/** May this agent run the technique stored under `techniqueId`? */
export function techniqueGranted(grants: AccessGrants, techniqueId: string): boolean {
  const t = techniqueGrantOf(grants);
  return t === '*' || t.includes(techniqueId);
}

/** Does this agent hold ANY technique grant (i.e. is the index worth rendering)? */
export function holdsAnyTechniqueGrant(grants: AccessGrants): boolean {
  const t = techniqueGrantOf(grants);
  return t === '*' || t.length > 0;
}

/**
 * MOST RESTRICTIVE (owner ruling 2): files + scratchpad only, no channels, no
 * integrations, no credentials.
 *
 * UX-ACCESS A2 wires this as THE default for a newly spawned agent, which is
 * what A1 declared it was for ("the shape A2's `spawn_agent`/`update_agent`
 * grant arguments start FROM") and deliberately did not do, because narrowing
 * before the grant door existed would have been a platform that cannot delegate.
 *
 * ── WHY THE THIRD LABEL, AND WHY IT IS A MEASUREMENT ──
 * A1 wrote `['Meta', 'File & System']`. Driven at `53955b0b` against the real
 * category index, that pair STRIPS `complete_task` and `send_to_agent` from the
 * advertised surface — both live in `Managing Other Agents` — and those two are
 * the sub-agent's own lifecycle, not a reach outside the dojo:
 *   · `tools/tool-docs.ts` declares `complete_task` on EVERY agent's
 *     always-loaded list with the reason "complete_task is how sub-agents signal
 *     they are done", and the spawn contract's initial message instructs the new
 *     agent to call it;
 *   · `send_to_agent` is how a sub-agent answers the creator that spawned it.
 * A default that makes both unreachable is not a restriction, it is a broken
 * spawn: the agent would be handed an always-loaded list of tools it does not
 * hold, and could neither report nor end.
 *
 * The rest of that label is walled elsewhere and independently, so granting it
 * widens nothing that was closed: `spawn_agent` / `kill_agent` /
 * `spawn_timeout_decision` by the manifest's `can_spawn_agents` (surface strip +
 * ladder row 4), `update_agent` / `get_agent_profile` / the four group verbs by
 * `PRIMARY_ONLY_TOOLS` (surface strip + ladder row 9), `reset_session` by row 10,
 * and `complete_task` itself by `agentCanSelfComplete` (FN-8). What a
 * default-spawned agent actually gains is `list_agents`, `list_models`,
 * `send_to_agent`, `broadcast_to_group` and `complete_task` — intra-dojo
 * coordination and its own lifecycle. Nothing here reaches a human, an
 * integration, a credential or the network.
 *
 * ── THE FOURTH AND FIFTH LABELS: THE WORK TRACKER (owner ruling, 2026-09-22) ──
 * OWNER, VERBATIM: *"By default, all agents should have this ability. It defeats the entire purpose
 * of the dojo and you have gates that prevent the agents from working if they don't open a task."*
 *
 * THE SELF-CONTRADICTION, MEASURED ON THE OWNER'S BOX: a live agent called `work_open` and was told
 * *"Permission denied: work_open is in the 'Open Work…' or 'Work Tracker…' tool group, which is not
 * in this agent's grants"* IN THE SAME TURN the engine's own start-ack hint
 * (`agent/v2/steps/assemble/start-ack-door.ts`) told it *"their request is being worked as a tracked
 * job."* The engine does not merely prefer the tracker, it DEPENDS on it: the going-idle re-prompt,
 * the close-out gate (`steps/execute/tracker-floors.ts`, `steps/execute/refusal-gates.ts`), the
 * promise floor (`steps/post-call-classify/promise-floor.ts`), the auto-open at 6 work calls, the
 * PM's re-drives and the thrash ladder's every escape hatch all name a work verb as the way OUT —
 * and under the old three-label default every one of those doors opened onto a refusal. Ruling 10e
 * (the tracker, the PM and the re-drives exist so a weak model finishes a long job) cannot be true
 * of a platform whose default withholds the tracker from every agent it creates. The six verbs
 * reach nothing outside the dojo — they write rows in this box's own `work` table, the same class
 * as the files and the lifecycle the other three labels already grant.
 *
 * ⚠ A CREATION DEFAULT AND A ONE-TIME BACKFILL, NOT A FLOOR. Existing agents gain the groups once,
 * through migration `168_work_tracker_default_grant.sql` (whose header carries the incident in full,
 * and the STABLE-BRIDGE ledger Entry 50 its safety argument). NOTHING re-applies this list at boot:
 * `access/materialize.ts` writes only where no grants are declared, deliberately, so an owner who
 * revokes a work group in the Access panel KEEPS it revoked across restarts. A default the platform
 * re-imposes every boot is not a default, it is a boot rewriter, and reverting the owner is the
 * exact defect the four retired boot reconcilers were deleted for.
 */
export const MOST_RESTRICTIVE_GRANTS: AccessGrants = {
  v: 1,
  tools: {
    categories: [
      'Meta', 'File & System', 'Managing Other Agents',
      // The work tracker — see above. `168_work_tracker_default_grant.sql` names the same two
      // strings, and `the-work-tracker-is-not-optional.test.ts` pins all five against the real
      // `TOOL_CATEGORIES` labels so a re-label cannot turn any of them into a dead grant.
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
  // UX-ACCESS A4: no technique either. A technique is a standing procedure the
  // agent follows without being asked — the matcher injects a strong match's
  // whole body before the agent says anything — so it is exactly the class
  // ruling 2 says is granted explicitly, never by default.
  techniques: [],
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
