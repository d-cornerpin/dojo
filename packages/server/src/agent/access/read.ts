// THE one read door: a stored object always wins, so an owner's edit sticks; with none stored,
// `deriveLegacyGrants` answers, so every door reads HEAD's measured access even before materializing.

import type { AccessChannel, AccessGrants, AccountKind, IntegrationLevel, ToolGrants } from '@dojo/shared';
import {
  channelTierOf, mayReachChannel, foldCredentialGrant,
  categoryGranted, providerLevelOf, techniqueGranted,
  mayReachOthersOn as mayReachOthersOnIn,
} from '@dojo/shared';
import { getDb } from '../../db/connection.js';
import { TOOL_CATEGORIES } from '../../tools/categories.js';
import { deriveLegacyGrants } from './derive.js';
import { canonicalizeToolsPolicy } from './tools-policy.js';
import { LIFT_TOOL } from '../v2/repeat-rule.js';

// The memo keys on the stored text itself: a write to the column self-invalidates the cache
// without any write site remembering to forget, so no writer can leave a stale verdict.
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
    // A half-written object falls back to the derivation rather than throwing at a tool door.
    if (!g || g.v !== 1 || !g.tools || !g.integrations || !g.channels) return null;
    return {
      ...g,
      tools: { ...g.tools, ...canonicalizeToolsPolicy(g.tools) },
      // THE credential fold, applied once here: no door, route, panel or audit ever sees the old shape.
      integrations: { ...g.integrations, credentials: foldCredentialGrant(g.integrations.credentials) },
    };
  } catch {
    return null;
  }
}

/** Declared grants or null: never falls back, because an edit needs to know a declaration exists. */
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
    // A database failure never narrows: same posture as grantFor's note in the broker grants.
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

/** The tier this agent holds on this channel: `none` / `owner` / `all`. */
export function channelTierFor(agentId: string, channel: AccessChannel) {
  return channelTierOf(getAccessGrants(agentId), channel);
}

export function mayReachOthersOn(agentId: string, channel: AccessChannel): boolean {
  return mayReachOthersOnIn(getAccessGrants(agentId), channel);
}

// ── Integrations ──

export function integrationLevelFor(
  agentId: string,
  provider: 'google' | 'microsoft',
  kind: AccountKind,
  accountId?: string | null,
): IntegrationLevel {
  return providerLevelOf(getAccessGrants(agentId).integrations[provider], kind, accountId);
}

export function widestIntegrationLevel(agentId: string, provider: 'google' | 'microsoft'): IntegrationLevel {
  const p = getAccessGrants(agentId).integrations[provider];
  const ranked: IntegrationLevel[] = ['none', 'read', 'full'];
  return ranked.indexOf(p.agent) >= ranked.indexOf(p.user) ? p.agent : p.user;
}

export function mayUsePlaud(agentId: string): boolean {
  return getAccessGrants(agentId).integrations.plaud;
}

// ── Credentials ──

export function holdsCredentialGrant(agentId: string): boolean {
  return getAccessGrants(agentId).integrations.credentials;
}

// ── Tools ──

export function toolGrantsFor(agentId: string): ToolGrants {
  return getAccessGrants(agentId).tools;
}

// A tool may sit under several labels; holding ANY of its categories holds the tool.
// Built once: TOOL_CATEGORIES is a module constant and cannot change at runtime.
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

export function toolCategoryLabels(tool: string): string[] {
  return [...categoriesOf(tool)];
}

/** Held whatever the groups or an allow list say (a deny by name still wins): loading a tool, lifting a loop stop, and
 *  for an agent given a job on an agent's thread (every ASSIGN opens or stamps a task), the ways to hand it back. */
export const alwaysHeld = (agentId: string): string[] => [...HELD, ...(getDb().prepare(
  "SELECT 1 FROM work WHERE agent_id = ? AND kind = 'task' AND a2a_thread_id IS NOT NULL LIMIT 1").get(agentId) ? JOB_HELD : [])];
const HELD = ['load_tool_docs', LIFT_TOOL], JOB_HELD = ['send_to_agent', 'complete_task'];

// A tool with no labels PASSES: the grant is a positive layer, not an allow-list of every name.
// One predicate for the surface strip AND the executor gate: two copies is how they drift apart.
export function toolCategoryGranted(agentId: string, tool: string): boolean {
  const labels = categoriesOf(tool);
  if (labels.length === 0 || HELD.includes(tool) || (JOB_HELD.includes(tool) && alwaysHeld(agentId).includes(tool))) return true;
  const grants = getAccessGrants(agentId);
  return labels.some((l) => categoryGranted(grants, l));
}

// ── Techniques ──

export function mayUseTechnique(agentId: string, techniqueId: string): boolean {
  return techniqueGranted(getAccessGrants(agentId), techniqueId);
}
