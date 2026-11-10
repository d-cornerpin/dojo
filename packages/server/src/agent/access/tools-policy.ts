// The strip and the executor's deny re-check must read the SAME allow/deny: copies drift wide.

import { resolveToolAlias } from '../../tools/aliases.js';

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
