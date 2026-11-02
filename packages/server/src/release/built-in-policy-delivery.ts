// ════════════════════════════════════════════════════════════════════════════════════════
// DELIVERING NEW TOOLS TO BUILT-IN AGENTS THAT ALREADY EXIST
//
// The service agents (Dreamer, PM) carry a curated tool allow list that is written ONCE, when the row is created or
// reactivated. The per-boot rewrite that used to refresh it was retired (v3.1.23) because it overwrote owner edits, so
// a tool added to the list in code afterwards never reached an existing row: the Dreamer of an upgraded box was
// refused `lesson_record` ("not accessible to this agent") and no lesson was ever written.
//
// The list an agent is held to lives in TWO places: the `tools_policy` column and `permissions.grants.tools` (the
// grants object, seeded from the column at boot and from then on the authority). Delivering to the column alone would
// change nothing on a box whose grants are already stored, so both are updated.
//
// STRICTLY ADDITIVE. Only the tools named in `POLICY_DELIVERIES` are added; nothing is removed or reordered, every other
// key survives, and a tool the owner has denied in EITHER place stays denied in both. Presence and denial are judged on
// canonical names (the alias table the doors use), so a row holding an old name already holds its replacement. An EMPTY
// or absent allow list means "unrestricted", so adding one name would NARROW the agent: those are left alone. A policy
// that does not parse is left exactly as it is and logged (updates never fail; it is counted in `flagged` but nothing is
// shown to the owner, since there is nothing for him to decide about a hand-broken row). Idempotent: a second pass finds
// every name present.
//
// A per-row problem never throws. A database that cannot be read does throw, so the runner keeps the step owed.
//
// KNOWN EDGE: delivery is version-gated, so a rollback to 3.4.1 followed by a re-upgrade (or a sibling step failing and
// holding the marker) runs the step again, and a delivered tool the owner had REMOVED from `allow` without denying it
// comes back. Denying it is the durable way to say no.
//
// WHICH NAMES: only tools added to a list AFTER the per-boot rewrite was retired (v3.1.23), because those can never have
// reached a frozen row and no owner can have removed them. Boxes last rewritten before 3.1.22 may lack some OLDER names
// (e.g. a PM from before 3.1.17 lacks vault_get); that gap predates 3.5 and is tracked separately, not delivered here:
// the step cannot tell an owner's trim from a name that never arrived.
//
// Adding a tool to a built-in agent's allow list means adding an entry here AND a `ReleaseStep` that calls
// `deliverPolicyTools` with the entry's `stepId`; `built-in-policy-delivery.test.ts` fails otherwise.
// ════════════════════════════════════════════════════════════════════════════════════════

import { getDb } from '../db/connection.js';
import { createLogger } from '../logger.js';
import { getDreamerAgentId, getPMAgentId } from '../config/platform.js';
import { forgetAccessGrants } from '../agent/access/read.js';
import { canonicalizeToolsPolicy } from '../agent/access/tools-policy.js';
import type { ReleaseStepOutcome } from './release-steps.js';

const logger = createLogger('policy-delivery');

export type PolicyAgent = 'dreamer' | 'pm';

export interface PolicyDelivery {
  readonly agent: PolicyAgent;
  readonly tool: string;
  /** The `ReleaseStep.id` that delivers it. */
  readonly stepId: string;
}

const S = 'built-in-policy-tools';
export const POLICY_DELIVERIES: readonly PolicyDelivery[] = [
  { agent: 'dreamer', tool: 'lesson_record', stepId: S },     // 3.5: one lesson per rough task
  { agent: 'pm', tool: 'tool_result_read', stepId: S },       // v3.4.0 (the surface also hands it to every agent)
];

// Exhaustive on purpose: widening `PolicyAgent` must fail to compile here rather than route to another agent's row.
const AGENT_IDS: Record<PolicyAgent, () => string> = { dreamer: getDreamerAgentId, pm: getPMAgentId };

const names = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);
/** Canonical names of a `{allow,deny}` holder's list, so an old alias and its replacement are one name. */
const canon = (v: unknown): ReadonlySet<string> => new Set(canonicalizeToolsPolicy({ allow: names(v), deny: [] }).allow);

/** Add `tool` to `holder.allow` in place when that is safe. Returns whether it changed. */
function addTo(holder: unknown, tool: string, denied: ReadonlySet<string>): boolean {
  if (!holder || typeof holder !== 'object' || Array.isArray(holder)) return false;
  const h = holder as { allow?: unknown };
  if (!Array.isArray(h.allow) || h.allow.length === 0) return false;      // unrestricted: adding would narrow it
  if (denied.has(tool)) return false;                                     // an owner denial stands, in both places
  if (canon(h.allow).has(tool)) return false;
  h.allow.push(tool);
  return true;
}

function parseObject(text: string | null): Record<string, unknown> | null {
  if (!text) return null;
  try {
    const v = JSON.parse(text);
    return v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : null;
  } catch { return null; }
}

/** Deliver every entry of `stepId`. A per-row problem is caught and counted; an unreadable database throws. */
export function deliverPolicyTools(stepId: string): ReleaseStepOutcome {
  const out: ReleaseStepOutcome = { examined: 0, flagged: 0, repaired: 0 };
  const db = getDb();
  for (const agent of [...new Set(POLICY_DELIVERIES.filter((d) => d.stepId === stepId).map((d) => d.agent))]) {
    const id = AGENT_IDS[agent]();
    const tools = POLICY_DELIVERIES.filter((d) => d.stepId === stepId && d.agent === agent);
    try {
      const row = db.prepare('SELECT tools_policy, permissions FROM agents WHERE id = ?').get(id) as
        { tools_policy: string | null; permissions: string | null } | undefined;
      if (!row) continue;
      out.examined++;
      const policy = parseObject(row.tools_policy);
      if (row.tools_policy && !policy) { out.flagged++; logger.warn('tools_policy does not parse; left as is', { agent: id }); }
      const perm = parseObject(row.permissions);
      if (row.permissions && row.permissions !== '{}' && !perm) { out.flagged++; logger.warn('permissions does not parse; left as is', { agent: id }); }
      const grants = perm?.grants as { tools?: { deny?: unknown } } | undefined;
      // A denial in either place is a denial for both: the panel writes only the grants, so the column can lag behind it.
      const denied = new Set([
        ...canonicalizeToolsPolicy({ allow: [], deny: names((policy as { deny?: unknown } | null)?.deny) }).deny,
        ...canonicalizeToolsPolicy({ allow: [], deny: names(grants?.tools?.deny) }).deny,
      ]);
      let policyText = row.tools_policy;
      let permText = row.permissions;
      let changed = false;
      if (policy && tools.map((d) => addTo(policy, d.tool, denied)).includes(true)) { policyText = JSON.stringify(policy); changed = true; }
      if (grants && tools.map((d) => addTo(grants.tools, d.tool, denied)).includes(true)) { permText = JSON.stringify(perm); changed = true; }
      if (!changed) continue;
      db.prepare("UPDATE agents SET tools_policy = ?, permissions = ?, updated_at = datetime('now') WHERE id = ?")
        .run(policyText, permText, id);
      forgetAccessGrants(id);
      out.repaired++;
      logger.info('built-in agent tool list extended', { agent: id });
    } catch (err) {
      out.flagged++;
      logger.warn('built-in agent tool delivery failed; left as is', { agent: id, error: err instanceof Error ? err.message : String(err) });
    }
  }
  return out;
}
