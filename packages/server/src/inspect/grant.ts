// ════════════════════════════════════════════════════════════════════════════════════════
// v3.5 inspect C1 — WHO HOLDS dojo_inspect. One predicate, asked at both layers.
//
// The tool reads every agent's conversation, the platform log and the database (credentials
// refused and blanked), so it is not a default for every agent. The plan's grant, and the owner's
// answer of 2026-10-20: the main agent and the Healer. Any other agent holds it only when its own
// tool grant NAMES it (`tools.allow` lists `dojo_inspect`); a blanket grant does not. A deny that
// names it wins for everyone, the main agent included.
//
// Asked by the advertised list (`agent/tools/surface.ts`, advice) and by the executor's gate row
// (`agent/tools/gate-eval.ts`, the wall), so "advertised" and "permitted" cannot drift; and by
// the shell redirect (`agent/brokers/dojo-redirect.ts`), which points only a holder at the tool.
// ════════════════════════════════════════════════════════════════════════════════════════

import { isHealerAgent, isPrimaryAgent } from '../config/platform.js';
import { toolGrantsFor } from '../agent/access/read.js';

export const DOJO_INSPECT = 'dojo_inspect';

export function holdsDojoInspect(agentId: string): boolean {
  const tools = toolGrantsFor(agentId);
  if (tools.deny.includes(DOJO_INSPECT)) return false;
  return isPrimaryAgent(agentId) || isHealerAgent(agentId) || tools.allow.includes(DOJO_INSPECT);
}

/**
 * THE GRANT DOORS (t267 review, Critical 1; fix round 2 rulings). Everywhere else `tools.allow`
 * RESTRICTS, so the no-escalation rule never judges a name in it; here a name in it GRANTS.
 * GRANT AUTHORITY IS THE OWNER (the dashboard/API routes, which do not ask) AND THE MAIN AGENT
 * while it holds the tool. A delegate that holds it may not re-delegate it, by name or by a child
 * inheriting its allow list; and lifting a deny that withholds it is a grant too, so no agent may.
 */
export function mayGrantDojoInspect(granterId: string): boolean {
  return isPrimaryAgent(granterId) && holdsDojoInspect(granterId);
}

const names = (list: unknown): boolean => Array.isArray(list) && list.includes(DOJO_INSPECT);

/** The refusal when an agent would NAME dojo_inspect in another agent's allow list; else null. */
export function inspectGrantRefusal(granterId: string, ...allows: unknown[]): string | null {
  if (!allows.some(names) || mayGrantDojoInspect(granterId)) return null;
  return 'tools.allow: cannot grant dojo_inspect — only the owner or the main agent can grant it.';
}

/** A spawned child's allow list with an INHERITED dojo_inspect dropped when its parent may not
 *  grant it; null when dropping would empty the list (an empty allow list means every tool). */
export function withoutInheritedInspect(granterId: string, allow: string[]): string[] | null {
  if (!allow.includes(DOJO_INSPECT) || mayGrantDojoInspect(granterId)) return allow;
  const kept = allow.filter((t) => t !== DOJO_INSPECT);
  return kept.length > 0 ? kept : null;
}

/** The refusal when an agent's edit would drop a deny that withholds dojo_inspect from `targetId`;
 *  only the owner lifts it. Each `denies` is a deny list the edit would store (undefined: untouched). */
export function inspectDenyLiftRefusal(targetId: string, ...denies: unknown[]): string | null {
  if (!toolGrantsFor(targetId).deny.includes(DOJO_INSPECT)) return null;
  if (!denies.some((d) => Array.isArray(d) && !d.includes(DOJO_INSPECT))) return null;
  return 'tools.deny: cannot lift the deny on dojo_inspect — the owner withheld it, and only the owner can give it back (from the dashboard).';
}

/** The refusal a non-holder reads at the executor. */
export const DOJO_INSPECT_REFUSAL = 'Permission denied: dojo_inspect is reserved for the main agent and the Healer, and for an agent whose own tool grant names it. The request was not performed. Ask the main agent if you need something looked up in the Dojo.';
