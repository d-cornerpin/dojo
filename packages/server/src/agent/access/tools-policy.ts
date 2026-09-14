// ════════════════════════════════════════════════════════════════════════════
// THE ONE TOOLS-POLICY PARSER (UX-ACCESS A1 — relocated verbatim from
// `agent/tools/surface.ts`, where it was private).
//
// FU-4's reason for there being exactly one is unchanged and is restated here
// because the module moved: the advertised-surface strip and the executor-side
// deny re-check must read the SAME canonicalized allow/deny, or they drift, and
// the drift is silent and in the permissive direction.
//
// A1 gives it a second caller — the access-grants snapshot (`derive.ts`), which
// migrates a stored `tools_policy` into `permissions.grants.tools`. Leaving the
// parser private in `surface.ts` would have meant a second copy in the access
// module, which is the disease. It is a leaf: the alias table and nothing else.
// ════════════════════════════════════════════════════════════════════════════

import { resolveToolAlias } from '../../tools/aliases.js';

export interface ToolsPolicy {
  allow: string[];
  deny: string[];
}

/**
 * Parse a stored `{allow,deny}` blob and canonicalize every name through the
 * alias table (C27 hook 4), so allow/deny still bind to the new tool after a
 * rename; tombstoned names are left as-is (they match nothing).
 */
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

/** Canonicalize an already-parsed pair (the grants object's own `tools` section,
 *  which is stored canonical but may have been hand-edited). */
export function canonicalizeToolsPolicy(policy: ToolsPolicy): ToolsPolicy {
  return { allow: policy.allow.map(canonical), deny: policy.deny.map(canonical) };
}

function canonical(name: string): string {
  const r = resolveToolAlias(name, {});
  return r.tombstone ? name : r.name;
}
