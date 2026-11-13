// After an update the Dreamer and the PM hold every tool their build lists: each missing name is appended to both stored
// lists (the column and the grants) unless the list is unrestricted, the owner denied the name in either place, or an
// audited edit of the agent's access took it out.
import { getDb } from '../db/connection.js';
import { getDreamerAgentId, getPMAgentId } from '../config/platform.js';
import { forgetAccessGrants } from '../agent/access/read.js';
import { canonicalizeToolsPolicy } from '../agent/access/tools-policy.js';
import { DREAMER_TOOLS_POLICY } from '../vault/maintenance.js';
import { PM_ALLOWED_TOOLS } from '../tracker/pm-agent.js';
import type { ReleaseStepOutcome } from './release-steps.js';

type Holder = { allow?: unknown; deny?: unknown };
const names = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);
const canon = (v: unknown): ReadonlySet<string> => new Set(canonicalizeToolsPolicy({ allow: names(v), deny: [] }).allow);
const parse = (text: string | null): Record<string, unknown> | null => {
  try { const v: unknown = JSON.parse(text ?? ''); return v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : null; } catch { return null; }
};

/** Append each of `tools` that `holder.allow` lacks and `skip` does not name, unless that list is empty (unrestricted). */
function addTo(holder: Holder | undefined, tools: readonly string[], skip: ReadonlySet<string>): boolean {
  if (!holder || !Array.isArray(holder.allow) || holder.allow.length === 0) return false;
  const held = canon(holder.allow);
  const add = [...canon(tools)].filter((t) => !skip.has(t) && !held.has(t));
  holder.allow.push(...add);
  return add.length > 0;
}

/** Names an audited edit of the agent's allow list took out and no later edit put back. */
function removedNames(agentId: string): Set<string> {
  const out = new Set<string>();
  const rows = getDb().prepare("SELECT detail FROM audit_log WHERE target = ? AND result = 'success' AND detail LIKE '%tools.allow:%' ORDER BY created_at, rowid").all(agentId) as Array<{ detail: string }>;
  for (const { detail } of rows) {
    const m = /tools\.allow: (\[[^\]]*\]) → (\[[^\]]*\])/.exec(detail);
    try {
      const [before, after] = [canon(JSON.parse(m?.[1] ?? '')), canon(JSON.parse(m?.[2] ?? ''))];
      before.forEach((t) => out.add(t));
      after.forEach((t) => out.delete(t));
    } catch { /* not an allow change this reader can read */ }
  }
  return out;
}

export function deliverBuiltInTools(): ReleaseStepOutcome {
  const out: ReleaseStepOutcome = { examined: 0, flagged: 0, repaired: 0 };
  const db = getDb();
  const agents: Array<[string, readonly string[]]> = [
    [getDreamerAgentId(), (JSON.parse(DREAMER_TOOLS_POLICY) as { allow: string[] }).allow],
    [getPMAgentId(), PM_ALLOWED_TOOLS],
  ];
  for (const [id, usual] of agents) {
    const row = db.prepare("SELECT tools_policy, permissions FROM agents WHERE id = ? AND status <> 'terminated'").get(id) as
      { tools_policy: string | null; permissions: string | null } | undefined;
    if (!row) continue;
    out.examined++;
    const policy = parse(row.tools_policy) as Holder | null;
    const perm = parse(row.permissions);
    const grants = (perm?.grants as { tools?: Holder } | undefined)?.tools;
    const skip = new Set([...canonicalizeToolsPolicy({ allow: [], deny: [...names(policy?.deny), ...names(grants?.deny)] }).deny, ...removedNames(id)]);
    const inColumn = addTo(policy ?? undefined, usual, skip);
    const inGrants = addTo(grants, usual, skip);
    if (inColumn || inGrants) {
      db.prepare("UPDATE agents SET tools_policy = ?, permissions = ?, updated_at = datetime('now') WHERE id = ?")
        .run(inColumn ? JSON.stringify(policy) : row.tools_policy, inGrants ? JSON.stringify(perm) : row.permissions, id);
      forgetAccessGrants(id);
      out.repaired++;
    }
  }
  return out;
}
