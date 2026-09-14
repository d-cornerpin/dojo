// ════════════════════════════════════════════════════════════════════════════
// READING AN AGENT'S GRANTS (UX-ACCESS A1) — the one door every enforcement
// layer asks.
//
// `agents.permissions` is a JSON DOCUMENT, and it now carries two things: the
// `PermissionManifest` (effect classes — files, exec, net, system control) read
// by `agent/manifest.ts`, and the `grants` object (tools, integrations,
// channels) read here. Two readers of one column is not two truths: they read
// DISJOINT keys, and the column is the single place an owner's access edit
// lands. A second table would have been the second truth.
//
// ── THE FALLBACK IS THE SAFETY NET, NOT A DEFAULT ──
// An agent with no stored `grants` answers with `deriveLegacyGrants` — its own
// effective access at HEAD, measured. That is what makes A1 byte-equivalent
// whether or not the materializer has run, on a fresh box and on the owner's.
// A stored object always wins, which is what makes an owner edit stick (owner
// ruling 3: the boot rewriter retires so edits stop silently reverting).
// ════════════════════════════════════════════════════════════════════════════

import type { AccessChannel, AccessGrants, AccountKind, IntegrationLevel, ToolGrants } from '@dojo/shared';
import {
  channelTierOf, mayReachChannel, mayTouchCredentialIn, holdsAnyCredentialGrant,
  categoryGranted, providerLevelOf, techniqueGrantOf, techniqueGranted, holdsAnyTechniqueGrant,
  mayReachOthersOn as mayReachOthersOnIn,
} from '@dojo/shared';
import { getDb } from '../../db/connection.js';
import { TOOL_CATEGORIES } from '../../tools/categories.js';
import { deriveLegacyGrants } from './derive.js';
import { canonicalizeToolsPolicy } from './tools-policy.js';

// ── The memo, keyed by the stored text itself ──
// Every read is one indexed SELECT of `agents.permissions`; the parse and the
// derivation are what cost, and both are pure functions of that text. Keying the
// memo on the text means a write to the column self-invalidates without any
// write site having to remember to forget — the same property `grantFor`'s
// fingerprint gives the broker grant.
const memo = new Map<string, { raw: string; grants: AccessGrants }>();
const MEMO_MAX = 512;

/** Test seam; forgetting is always safe (the next read re-parses). */
export function forgetAccessGrants(agentId?: string): void {
  if (agentId) memo.delete(agentId); else memo.clear();
}

function storedGrants(raw: string | null): AccessGrants | null {
  if (!raw || raw === '{}') return null;
  try {
    const parsed = JSON.parse(raw) as { grants?: unknown };
    const g = parsed.grants as AccessGrants | undefined;
    // Shape check, not a schema validator: the three sections are what every
    // reader below indexes into, and a half-written object must fall back to the
    // measured derivation rather than throw at a tool door.
    if (!g || g.v !== 1 || !g.tools || !g.integrations || !g.channels) return null;
    return { ...g, tools: { ...g.tools, ...canonicalizeToolsPolicy(g.tools) } };
  } catch {
    return null;
  }
}

/**
 * The grants this agent DECLARES, or null if it declares none (UX-ACCESS A2).
 *
 * The other question, and the reason it is not `getAccessGrants`: that one never
 * answers null, because a row with no stored object falls back to the measured A1
 * snapshot so every DOOR has something to read. An EDIT needs to know whether
 * there is a declaration here at all, and answering it with the derivation would
 * quietly promote a snapshot to a declaration.
 */
export function readStoredGrants(agentId: string): AccessGrants | null {
  const raw = (getDb().prepare('SELECT permissions FROM agents WHERE id = ?').get(agentId) as
    { permissions: string | null } | undefined)?.permissions ?? null;
  return storedGrants(raw);
}

/** THE grants for this agent: stored if declared, else today's measured access. */
export function getAccessGrants(agentId: string): AccessGrants {
  let raw: string | null = null;
  try {
    raw = (getDb().prepare('SELECT permissions FROM agents WHERE id = ?').get(agentId) as
      { permissions: string | null } | undefined)?.permissions ?? null;
  } catch {
    // A database failure never narrows — see `grantFor`'s own note.
    return deriveLegacyGrants(agentId);
  }
  const key = raw ?? '';
  const cached = memo.get(agentId);
  if (cached && cached.raw === key) return cached.grants;
  const grants = storedGrants(raw) ?? deriveLegacyGrants(agentId);
  memo.delete(agentId);
  memo.set(agentId, { raw: key, grants });
  if (memo.size > MEMO_MAX) {
    const oldest = memo.keys().next().value;
    if (oldest !== undefined) memo.delete(oldest);
  }
  return grants;
}

// ── Channels (the doors) ──

/** May this agent reach a human on this channel? The ONE channel predicate. */
export function mayUseChannel(agentId: string, channel: AccessChannel): boolean {
  return mayReachChannel(getAccessGrants(agentId), channel);
}

/** The tier — `none` / `owner` / `all` — this agent holds on this channel. */
export function channelTierFor(agentId: string, channel: AccessChannel) {
  return channelTierOf(getAccessGrants(agentId), channel);
}

/**
 * May this agent reach a NON-OWNER recipient on this channel? (UX-ACCESS A4.)
 *
 * The me-vs-others half of owner ruling 1. A1 declared the tier,
 * A2 taught the no-escalation ladder to compare it and A3 drew it in the panel,
 * and until A4 the shared `mayReachOthersOn` predicate had no server-side caller
 * at all — a declared field with no reader, which is the shape this overhaul
 * exists to end. Its first door is `imessage_send`'s, beside the four walls A1
 * wrote in the same file.
 */
export function mayReachOthersOn(agentId: string, channel: AccessChannel): boolean {
  return mayReachOthersOnIn(getAccessGrants(agentId), channel);
}

/** Does this agent have the human-channel master switch at all? (`null` = a
 *  sensei other than the primary, which communicates through the main agent.) */
export function hasChannelMaster(agentId: string): boolean {
  return getAccessGrants(agentId).channels.master !== null;
}

// ── Integrations ──

/** This agent's granted Workspace tier for one provider/account-kind. */
export function integrationLevelFor(
  agentId: string,
  provider: 'google' | 'microsoft',
  kind: AccountKind,
  accountId?: string | null,
): IntegrationLevel {
  return providerLevelOf(getAccessGrants(agentId).integrations[provider], kind, accountId);
}

/** The widest tier this agent holds on a provider across both account kinds —
 *  the answer the surface's single `access` variable has always needed. */
export function widestIntegrationLevel(agentId: string, provider: 'google' | 'microsoft'): IntegrationLevel {
  const p = getAccessGrants(agentId).integrations[provider];
  const ranked: IntegrationLevel[] = ['none', 'read', 'full'];
  return ranked.indexOf(p.agent) >= ranked.indexOf(p.user) ? p.agent : p.user;
}

/** Is the Plaud integration granted to this agent? */
export function mayUsePlaud(agentId: string): boolean {
  return getAccessGrants(agentId).integrations.plaud;
}

// ── Credentials ──

export function mayTouchCredential(agentId: string, serviceName: string): boolean {
  return mayTouchCredentialIn(getAccessGrants(agentId), serviceName);
}

export function holdsCredentialGrant(agentId: string): boolean {
  return holdsAnyCredentialGrant(getAccessGrants(agentId));
}

// ── Tools ──

/** The curated allow/deny this agent carries (migrated `tools_policy`). */
export function toolGrantsFor(agentId: string): ToolGrants {
  return getAccessGrants(agentId).tools;
}

// A tool may appear under more than one label (`work_open` is in two); holding
// ANY of its categories is holding the tool. Built once — `TOOL_CATEGORIES` is a
// module constant and cannot change at runtime.
let categoryIndex: Map<string, string[]> | null = null;
function categoriesOf(tool: string): string[] {
  if (!categoryIndex) {
    categoryIndex = new Map();
    for (const c of TOOL_CATEGORIES) {
      for (const t of c.tools) {
        const list = categoryIndex.get(t);
        if (list) list.push(c.label); else categoryIndex.set(t, [c.label]);
      }
    }
  }
  return categoryIndex.get(tool) ?? [];
}

/**
 * The `TOOL_CATEGORIES` labels this tool is filed under; empty for a tool the
 * index does not name.
 *
 * Exported for the EXECUTOR's row-17 gate (UX-ACCESS A3): the declaration in
 * `gates.ts` asks whether the tool is categorised at all, and the refusal names
 * the group the owner would have to grant. Both answers have to come from this
 * index and not from a second list, which is the same reason the surface strip
 * and the gate share `toolCategoryGranted` below.
 */
export function toolCategoryLabels(tool: string): string[] {
  return [...categoriesOf(tool)];
}

/**
 * Is this tool inside a granted CATEGORY?
 *
 * A tool in NO category (the `user_` twins, the Office set, anything newly
 * registered outside the index) passes: the category grant is a positive layer
 * over the 38 declared groups, not an allow-list of every name the platform can
 * mint, and treating an unlisted name as denied would refuse tools the owner
 * never saw a control for.
 *
 * ── ONE PREDICATE, TWO LAYERS (UX-ACCESS A3) ──
 * This is the surface strip's filter (`surface.ts`) AND the executor's row-17
 * gate. Architecture Rule 1: the strip is advice — the floor model parses tool
 * calls out of free text and can emit a name it was never advertised — so until
 * A3 an agent granted a channel but not the tool's group passed the permission
 * door while its own capability line said it could not (A2 §6.1, measured).
 * Asking the same function at both layers is what stops "advertised" and
 * "permitted" from drifting apart again.
 */
export function toolCategoryGranted(agentId: string, tool: string): boolean {
  const labels = categoriesOf(tool);
  if (labels.length === 0) return true;
  const grants = getAccessGrants(agentId);
  return labels.some((l) => categoryGranted(grants, l));
}

// ── Techniques (UX-ACCESS A4) ──

/** The technique grant this agent holds — `'*'` or an explicit id list. */
export function techniqueGrantFor(agentId: string): string[] | '*' {
  return techniqueGrantOf(getAccessGrants(agentId));
}

/**
 * May this agent run this technique? THE ONE technique predicate.
 *
 * Asked by all four places a technique reaches an agent (the published index,
 * the matcher's candidate set, the `use_technique` / `technique_read` door, and
 * the equipped pre-load), for the same reason `toolCategoryGranted` is asked by
 * both the surface strip and row 17: a second copy of the rule is how
 * "advertised" and "permitted" drift apart.
 */
export function mayUseTechnique(agentId: string, techniqueId: string): boolean {
  return techniqueGranted(getAccessGrants(agentId), techniqueId);
}

/** Does this agent hold any technique at all? */
export function holdsTechniqueGrant(agentId: string): boolean {
  return holdsAnyTechniqueGrant(getAccessGrants(agentId));
}
