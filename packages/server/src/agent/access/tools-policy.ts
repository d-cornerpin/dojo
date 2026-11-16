// The strip and the executor's deny re-check must read the SAME allow/deny: copies drift wide.

import type { AccessGrants } from '@dojo/shared';
import { resolveToolAlias } from '../../tools/aliases.js';
import { TOOL_CATEGORIES } from '../../tools/categories.js';

export interface ToolsPolicy {
  allow: string[];
  deny: string[];
}

// Parses a stored {allow,deny} blob and canonicalizes every name through the alias table, so a
// policy still binds after a rename; tombstoned names are left alone (they match nothing).
export function parseToolsPolicyText(raw: string | null | undefined): ToolsPolicy {
  let allow: string[] = [];
  let deny: string[] = [];
  if (raw) {
    try {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed.allow)) allow = parsed.allow;
      if (Array.isArray(parsed.deny)) deny = parsed.deny;
    } catch { /* ignore malformed policy */ }
  }
  return { allow: allow.map(canonical), deny: deny.map(canonical) };
}

/** Same canonicalization for an already-parsed pair: stored canonical, but it may be hand-edited. */
export function canonicalizeToolsPolicy(policy: ToolsPolicy): ToolsPolicy {
  return { allow: policy.allow.map(canonical), deny: policy.deny.map(canonical) };
}

function canonical(name: string): string {
  const r = resolveToolAlias(name, {});
  return r.tombstone ? name : r.name;
}

/** An empty allow is UNRESTRICTED, so appending would narrow it: it is returned unchanged. */
export function appendTools(allow: readonly string[], add: readonly string[]): string[] {
  if (allow.length === 0) return [];
  const held = new Set(allow.map(canonical));
  return [...allow, ...add.map(canonical).filter((t) => !held.has(t) && held.add(t))];
}

const WEB = TOOL_CATEGORIES.find((c) => c.label === 'Web')!;

/** The owner's web toggles write a tools policy: one that leaves a Web tool undenied also grants the Web
 *  group, so the toggle does what it says, unless the same save names the tool groups itself (that choice
 *  wins). Turning the toggles off denies the tools and keeps the group. */
export function withWebGroupFor(grants: AccessGrants, policy: { deny?: unknown } | null | undefined, requested: unknown): AccessGrants {
  const categories = grants.tools.categories;
  const named = (requested as { tools?: { categories?: unknown } } | null | undefined)?.tools?.categories !== undefined;
  if (!policy || named || categories === '*' || categories.includes(WEB.label)) return grants;
  const deny = Array.isArray(policy.deny) ? policy.deny : [];
  if (WEB.tools.every((t) => deny.includes(t))) return grants;
  return { ...grants, tools: { ...grants.tools, categories: [...categories, WEB.label] } };
}
