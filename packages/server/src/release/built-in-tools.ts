// After an update the Dreamer and the PM hold the tool their build added since their rows were written: it is appended
// to both stored lists (the column and the grants) unless the list is unrestricted or the owner denied it in either
// place. Any older listed tool still missing is the owner's call, raised once on the card in built-in-tools-card.ts.
import { getDb } from '../db/connection.js';
import { getDreamerAgentId, getPMAgentId } from '../config/platform.js';
import { forgetAccessGrants } from '../agent/access/read.js';
import { canonicalizeToolsPolicy } from '../agent/access/tools-policy.js';
import { DREAMER_TOOLS_POLICY } from '../vault/maintenance.js';
import { PM_ALLOWED_TOOLS } from '../tracker/pm-agent.js';
import { raiseBuiltInToolsCard } from '../services/built-in-tools-card.js';
import type { ReleaseStepOutcome } from './release-steps.js';

type Holder = { allow?: unknown; deny?: unknown };
const names = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);
const canon = (v: unknown): ReadonlySet<string> => new Set(canonicalizeToolsPolicy({ allow: names(v), deny: [] }).allow);
const parse = (text: string | null): Record<string, unknown> | null => {
  try { const v: unknown = JSON.parse(text ?? ''); return v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : null; } catch { return null; }
};

/** Append `tool` to `holder.allow` unless that list is empty (unrestricted), denies it, or already holds it. */
function addTo(holder: Holder | undefined, tool: string, denied: ReadonlySet<string>): boolean {
  if (!holder || !Array.isArray(holder.allow) || holder.allow.length === 0 || denied.has(tool) || canon(holder.allow).has(tool)) return false;
  holder.allow.push(tool);
  return true;
}

export function deliverBuiltInTools(): ReleaseStepOutcome {
  const out: ReleaseStepOutcome = { examined: 0, flagged: 0, repaired: 0 };
  const db = getDb();
  const agents: Array<[string, string, readonly string[]]> = [
    [getDreamerAgentId(), 'lesson_record', (JSON.parse(DREAMER_TOOLS_POLICY) as { allow: string[] }).allow],
    [getPMAgentId(), 'tool_result_read', PM_ALLOWED_TOOLS],
  ];
  for (const [id, tool, usual] of agents) {
    const row = db.prepare("SELECT tools_policy, permissions FROM agents WHERE id = ? AND status <> 'terminated'").get(id) as
      { tools_policy: string | null; permissions: string | null } | undefined;
    if (!row) continue;
    out.examined++;
    const policy = parse(row.tools_policy) as Holder | null;
    const perm = parse(row.permissions);
    const grants = (perm?.grants as { tools?: Holder } | undefined)?.tools;
    const denied = new Set(canonicalizeToolsPolicy({ allow: [], deny: [...names(policy?.deny), ...names(grants?.deny)] }).deny);
    const inColumn = addTo(policy ?? undefined, tool, denied);
    const inGrants = addTo(grants, tool, denied);
    if (inColumn || inGrants) {
      db.prepare("UPDATE agents SET tools_policy = ?, permissions = ?, updated_at = datetime('now') WHERE id = ?")
        .run(inColumn ? JSON.stringify(policy) : row.tools_policy, inGrants ? JSON.stringify(perm) : row.permissions, id);
      forgetAccessGrants(id);
      out.repaired++;
    }
    if (raiseBuiltInToolsCard(id, usual)) out.flagged++;
  }
  return out;
}
