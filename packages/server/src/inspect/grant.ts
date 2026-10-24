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
 * THE GRANT DOORS (t267 review, Critical 1). Everywhere else `tools.allow` RESTRICTS, so the
 * no-escalation rule never judges a name in it; here a name in it GRANTS. So an agent that does
 * not hold dojo_inspect may not write it into another agent's allow list (spawn, update_agent).
 * The owner's dashboard routes do not ask: the owner grants it. Each `allows` is any allow list
 * the call would store (grants.tools.allow, the older tools argument).
 */
export function inspectGrantRefusal(granterId: string, ...allows: unknown[]): string | null {
  if (!allows.some((a) => Array.isArray(a) && a.includes(DOJO_INSPECT)) || holdsDojoInspect(granterId)) return null;
  return 'tools.allow: cannot grant dojo_inspect — only an agent that holds it (the main agent, the Healer) or the owner can grant it.';
}

/** The refusal a non-holder reads at the executor. */
export const DOJO_INSPECT_REFUSAL = 'Permission denied: dojo_inspect is reserved for the main agent and the Healer, and for an agent whose own tool grant names it. The request was not performed. Ask the main agent if you need something looked up in the Dojo.';
