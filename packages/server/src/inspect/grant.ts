// ════════════════════════════════════════════════════════════════════════════════════════
// v3.5 inspect C1 — WHO HOLDS dojo_inspect. One predicate, asked at both layers.
//
// The tool reads every agent's conversation, the platform log and the database (credentials
// refused and blanked), so it is not a default for every agent. The plan's grant, and the owner's
// answer of 2026-10-20: the main agent and the Healer. Any other agent holds it only when its own
// tool grant NAMES it (`tools.allow` lists `dojo_inspect`); a blanket grant does not. A deny that
// names it wins for everyone, the main agent included. The dashboard files the tool under
// "Oversight & Admin", so the owner switching that group off withdraws it from the main agent and
// the Healer too (fix round 4 ruling: the switch means what it shows); naming it is its own grant.
//
// Asked by the advertised list (`agent/tools/surface.ts`, advice) and by the executor's gate row
// (`agent/tools/gate-eval.ts`, the wall), so "advertised" and "permitted" cannot drift; and by
// the shell redirect (`agent/brokers/dojo-redirect.ts`), which points only a holder at the tool.
// ════════════════════════════════════════════════════════════════════════════════════════

import { isHealerAgent, isPrimaryAgent } from '../config/platform.js';
import { toolGrantsFor, toolCategoryGranted, forgetAccessGrants } from '../agent/access/read.js';
import { getDb } from '../db/connection.js';

export const DOJO_INSPECT = 'dojo_inspect';

export function holdsDojoInspect(agentId: string): boolean {
  const tools = toolGrantsFor(agentId);
  if (tools.deny.includes(DOJO_INSPECT)) return false;
  if (tools.allow.includes(DOJO_INSPECT)) return true;
  return (isPrimaryAgent(agentId) || isHealerAgent(agentId)) && toolCategoryGranted(agentId, DOJO_INSPECT);
}

/**
 * THE GRANT DOORS (t267 review, Critical 1; fix round 2 rulings). Everywhere else `tools.allow`
 * RESTRICTS, so the no-escalation rule never judges a name in it; here a name in it GRANTS.
 * GRANT AUTHORITY IS THE OWNER (the dashboard/API routes, which do not ask) AND THE MAIN AGENT
 * while it holds the tool. A delegate that holds it may not re-delegate it, by name or by a child
 * inheriting its allow list; and giving back what the owner withheld is a grant too, so no agent may.
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

/**
 * AN AGENT'S EDIT OF ANOTHER AGENT, JUDGED ON WHAT IT LEAVES (fix round 4 ruling). Judging the
 * arrays a call carries missed a blanked or partial stored grants object, which reads as the
 * derivation (no deny) and gave a withheld main agent or Healer the tool back by identity. So the
 * edit runs inside a savepoint that is ALWAYS rolled back, the target is asked through the one
 * predicate, and the edit is refused when the target would GAIN the tool: from an agent the owner
 * withheld it from (a deny, or the main agent / Healer with its group switched off) always; from
 * any other target unless the editor may grant it. The edit's OWN refusal (no escalation, no
 * permission) is passed back too, so a refused call writes nothing. Null: make the edit for real.
 * The owner's dashboard/API routes do not ask.
 */
export function inspectGainRefusal<R>(editorId: string, targetId: string, edit: () => R | null): R | string | null {
  const held = holdsDojoInspect(targetId);
  const withheld = toolGrantsFor(targetId).deny.includes(DOJO_INSPECT) || isPrimaryAgent(targetId) || isHealerAgent(targetId);
  const db = getDb();
  let gains = false;
  let editRefused: R | null = null;
  db.exec('SAVEPOINT inspect_gain');
  try {
    editRefused = edit();
    forgetAccessGrants(targetId);
    gains = !held && holdsDojoInspect(targetId);
  } finally {
    db.exec('ROLLBACK TO inspect_gain');
    db.exec('RELEASE inspect_gain');
    forgetAccessGrants(targetId);
  }
  if (editRefused) return editRefused;   // the edit's own refusal, returned before ANY write: all-or-nothing
  if (!gains || (!withheld && mayGrantDojoInspect(editorId))) return null;
  return withheld
    ? 'Refused, and nothing was changed: this edit would give dojo_inspect back, but the owner withheld it from this agent; only the owner can give it back, from the dashboard.'
    : 'Refused, and nothing was changed: this edit would give this agent dojo_inspect, which only the owner or the main agent can grant.';
}

/** The refusal a non-holder reads at the executor. */
export const DOJO_INSPECT_REFUSAL = 'Permission denied: dojo_inspect is reserved for the main agent and the Healer, and for an agent whose own tool grant names it. The request was not performed. Ask the main agent if you need something looked up in the Dojo.';
