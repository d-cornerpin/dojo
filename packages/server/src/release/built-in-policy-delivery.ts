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
// key survives, and a tool the owner has denied stays denied. An EMPTY or absent allow list means "unrestricted", so
// adding one name would NARROW the agent: those are left alone. A policy that does not parse is left exactly as it is
// and reported (updates never fail). Idempotent: a second pass finds every name present.
//
// Adding a tool to a built-in agent's allow list means adding an entry here AND a `ReleaseStep` that calls
// `deliverPolicyTools` with the entry's `stepId`; `built-in-policy-delivery.test.ts` fails otherwise.
// ════════════════════════════════════════════════════════════════════════════════════════

import { getDb } from '../db/connection.js';
import { createLogger } from '../logger.js';
import { getDreamerAgentId, getPMAgentId } from '../config/platform.js';
import { forgetAccessGrants } from '../agent/access/read.js';
import type { ReleaseStepOutcome } from './release-steps.js';

const logger = createLogger('policy-delivery');

export type PolicyAgent = 'dreamer' | 'pm';

export interface PolicyDelivery {
  readonly agent: PolicyAgent;
  readonly tool: string;
  /** The `ReleaseStep.id` that delivers it. */
  readonly stepId: string;
}

export const POLICY_DELIVERIES: readonly PolicyDelivery[] = [
  // Added 3.5: the Dreamer writes one lesson per rough task.
  { agent: 'dreamer', tool: 'lesson_record', stepId: 'built-in-policy-tools' },
  // Added 3.4.0: the reader of the agent's own long tool results. Every agent is also given it by the surface; this
  // keeps the stored list equal to the code's.
  { agent: 'pm', tool: 'tool_result_read', stepId: 'built-in-policy-tools' },
];

const agentId = (a: PolicyAgent): string => (a === 'dreamer' ? getDreamerAgentId() : getPMAgentId());

/** Add `tool` to `holder.allow` in place when that is safe. Returns whether it changed. */
function addTo(holder: unknown, tool: string): boolean {
  if (!holder || typeof holder !== 'object' || Array.isArray(holder)) return false;
  const h = holder as { allow?: unknown; deny?: unknown };
  if (!Array.isArray(h.allow) || h.allow.length === 0) return false;      // unrestricted: adding would narrow it
  if (Array.isArray(h.deny) && h.deny.includes(tool)) return false;       // an owner denial stays
  if (h.allow.includes(tool)) return false;
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

/** Deliver every entry of `stepId`. Never throws. */
export function deliverPolicyTools(stepId: string): ReleaseStepOutcome {
  const out: ReleaseStepOutcome = { examined: 0, flagged: 0, repaired: 0 };
  const db = getDb();
  for (const agent of [...new Set(POLICY_DELIVERIES.filter((d) => d.stepId === stepId).map((d) => d.agent))]) {
    const id = agentId(agent);
    const tools = POLICY_DELIVERIES.filter((d) => d.stepId === stepId && d.agent === agent).map((d) => d.tool);
    try {
      const row = db.prepare('SELECT tools_policy, permissions FROM agents WHERE id = ?').get(id) as
        { tools_policy: string | null; permissions: string | null } | undefined;
      if (!row) continue;
      out.examined++;
      let policyText = row.tools_policy;
      let permText = row.permissions;
      let changed = false;
      const policy = parseObject(row.tools_policy);
      if (row.tools_policy && !policy) { out.flagged++; logger.warn('tools_policy does not parse; left as is', { agent: id }); }
      if (policy && tools.map((t) => addTo(policy, t)).includes(true)) { policyText = JSON.stringify(policy); changed = true; }
      const perm = parseObject(row.permissions);
      if (row.permissions && row.permissions !== '{}' && !perm) { out.flagged++; logger.warn('permissions does not parse; left as is', { agent: id }); }
      const grants = perm?.grants as { tools?: unknown } | undefined;
      if (grants && tools.map((t) => addTo(grants.tools, t)).includes(true)) { permText = JSON.stringify(perm); changed = true; }
      if (!changed) continue;
      db.prepare("UPDATE agents SET tools_policy = ?, permissions = ?, updated_at = datetime('now') WHERE id = ?")
        .run(policyText, permText, id);
      forgetAccessGrants(id);
      out.repaired++;
      logger.info('built-in agent tool list extended', { agent: id, tools });
    } catch (err) {
      out.flagged++;
      logger.warn('built-in agent tool delivery failed; left as is', { agent: id, error: err instanceof Error ? err.message : String(err) });
    }
  }
  return out;
}
