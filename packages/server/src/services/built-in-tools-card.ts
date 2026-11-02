// ════════════════════════════════════════════════════════════════════════════════════════
// THE OWNER'S CARD FOR A BUILT-IN AGENT THAT LACKS TOOLS ITS BUILD LISTS (proof-fix-u).
//
// The Dreamer and PM keep the tool list their row last held, and a row last written by an old build can lack tools added
// since (the per-boot rewrite that refreshed it was retired at 3.1.23). Nothing the product records tells an owner who
// trimmed that list from a name that never arrived: the policy column and the stored grants are both plain lists, the
// panel and `update_agent` write them without a stamp, and the audit rows are free text that an unaudited write or the
// pre-grants window leaves no trace in. So no upgrade ever puts a name back. It says so ONCE, on the owner's dashboard
// (the owner-notices cards: dismissable, re-derived on every load, no new UX), and he adds them or dismisses.
//
// The record is one `config` row, `{ [agentId]: { names, told?, dismissed? } }`: the names found missing at the upgrade.
// A card stands while it is not dismissed and some recorded name is still missing from what the agent holds NOW (the
// stored grants win, as at every door), so it ends by itself once he adds them. Older builds ignore the row.
// ════════════════════════════════════════════════════════════════════════════════════════

import { getDb } from '../db/connection.js';
import { getAccessGrants } from '../agent/access/read.js';
import { canonicalizeToolsPolicy, parseToolsPolicyText } from '../agent/access/tools-policy.js';
import { getPrimaryAgentId } from '../config/platform.js';
import { RESULT_READ_TOOL } from '../memory/tool-result-view.js';
import { dojoVoice } from '../agent/dojo-voice.js';
import { ownerCardEnded } from './owner-card-frames.js';

export const GAP_KEY = 'built_in_tools_gap';
export type GapEntry = { names: string[]; told?: boolean; dismissed?: boolean; cleared?: boolean };
type GapRecord = Record<string, GapEntry>;

const nameOf = (id: string): string =>
  (getDb().prepare('SELECT name FROM agents WHERE id = ?').get(id) as { name: string | null } | undefined)?.name || id;

/**
 * Which of `usual` this agent does not hold: not in what it is allowed (stored grants, else the column), not denied in
 * either place. An unrestricted agent (empty allow) holds everything; a row that does not parse cannot be judged.
 * A missing or terminated row answers none; an unreadable database throws.
 */
export function missingTools(agentId: string, usual: readonly string[]): string[] {
  const row = getDb().prepare('SELECT tools_policy, permissions, status FROM agents WHERE id = ?').get(agentId) as
    { tools_policy: string | null; permissions: string | null; status: string | null } | undefined;
  if (!row || row.status === 'terminated') return [];   // a terminated agent is rewritten in full if it is ever reactivated
  for (const text of [row.tools_policy, row.permissions]) {
    if (!text || text === '{}') continue;
    try { JSON.parse(text); } catch { return []; }
  }
  const held = getAccessGrants(agentId).tools;
  if (held.allow.length === 0) return [];
  const have = new Set(canonicalizeToolsPolicy({ allow: held.allow, deny: [] }).allow);
  const denied = new Set([...canonicalizeToolsPolicy({ allow: [], deny: held.deny }).deny, ...parseToolsPolicyText(row.tools_policy).deny]);
  const wanted = canonicalizeToolsPolicy({ allow: [...usual], deny: [] }).allow;
  return [...new Set(wanted)].filter((t) => t !== RESULT_READ_TOOL && !have.has(t) && !denied.has(t));
}

export function readGap(): GapRecord {
  try {
    const row = getDb().prepare('SELECT value FROM config WHERE key = ?').get(GAP_KEY) as { value: string } | undefined;
    const parsed = row ? JSON.parse(row.value) as GapRecord : {};
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch { return {}; }
}

export function writeGap(record: GapRecord): void {
  getDb().prepare(`INSERT INTO config (key, value, updated_at) VALUES (?, ?, datetime('now'))
                   ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = datetime('now')`).run(GAP_KEY, JSON.stringify(record));
}

/** The card's words. Plain, the Dojo speaking, and exact: nothing was changed, and who can add them. */
export function gapWords(agentName: string, mainName: string, names: readonly string[]): string {
  return dojoVoice(`${agentName} doesn't have some tools a new ${agentName} gets: ${names.join(', ')}. Nothing was changed. `
    + `If you removed them on purpose, close this card. If not, ask ${mainName} to add them.`);
}

/** The cards a dashboard shows on load: recorded, not dismissed, and something recorded is still missing. */
export function builtInToolsOwnerCards(): Array<{ words: string; severity: 'notice'; cardKey: string; dismiss: () => void }> {
  const record = readGap();
  const out: Array<{ words: string; severity: 'notice'; cardKey: string; dismiss: () => void }> = [];
  for (const [id, entry] of Object.entries(record)) {
    if (entry?.dismissed || entry?.cleared || !Array.isArray(entry?.names)) continue;
    let names: string[];
    try { names = missingTools(id, entry.names); } catch { continue; }
    if (names.length === 0) {
      // Nothing is missing any more (the owner added them, or the agent is gone): the incident is over for good, so a
      // later removal of his own raises nothing, and the card leaves every open dashboard now.
      try { if (!(readGap()[id]?.cleared)) { writeGap({ ...readGap(), [id]: { ...entry, cleared: true } }); ownerCardEnded('closed', `built-in-tools:${id}`); } } catch { /* shown again at worst */ }
      continue;
    }
    out.push({
      words: gapWords(nameOf(id), nameOf(getPrimaryAgentId()), names), severity: 'notice', cardKey: `built-in-tools:${id}`,
      dismiss: () => { const now = readGap(); if (now[id]) writeGap({ ...now, [id]: { ...now[id], dismissed: true } }); },
    });
  }
  return out;
}
