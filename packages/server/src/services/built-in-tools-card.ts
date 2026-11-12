// The owner's card for a built-in agent lacking tools its build lists (`built-in-tools:<id>`), raised once.
// Nothing recorded tells a missing tool from an owner's trim, so no upgrade puts a name back.
// The `config` row `{ [agentId]: { names } }` records each agent already raised, so it is never raised twice.

import { getDb } from '../db/connection.js';
import { getAccessGrants } from '../agent/access/read.js';
import { canonicalizeToolsPolicy, parseToolsPolicyText } from '../agent/access/tools-policy.js';
import { getPrimaryAgentId } from '../config/platform.js';
import { RESULT_READ_TOOL } from '../memory/tool-result-view.js';
import { dojoVoice } from '../agent/dojo-voice.js';
import { postAgentNotice } from '../agent/agent-notice.js';
import { tellOwner } from '../healer/owner-notices.js';

const GAP_KEY = 'built_in_tools_gap';
type GapEntry = { names: string[] };
type GapRecord = Record<string, GapEntry>;

const nameOf = (id: string): string =>
  (getDb().prepare('SELECT name FROM agents WHERE id = ?').get(id) as { name: string | null } | undefined)?.name || id;

/** Which of `usual` the agent neither holds nor has denied; an unrestricted or unparseable row answers none. */
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

function writeGap(record: GapRecord): void {
  getDb().prepare(`INSERT INTO config (key, value, updated_at) VALUES (?, ?, datetime('now'))
                   ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = datetime('now')`).run(GAP_KEY, JSON.stringify(record));
}

function gapWords(agentName: string, mainName: string, names: readonly string[]): string {
  return dojoVoice(`${agentName} doesn't have some tools a new ${agentName} gets: ${names.join(', ')}. Nothing was changed. `
    + `If you removed them on purpose, close this card. If not, ask ${mainName} to add them.`);
}

/** Raise the card once for an agent lacking tools of `usual` and tell the main agent so it can add them. */
export function raiseBuiltInToolsCard(id: string, usual: readonly string[]): boolean {
  if (readGap()[id]) return false;
  const names = missingTools(id, usual);
  if (names.length === 0) return false;
  const main = getPrimaryAgentId();
  const words = gapWords(nameOf(id), nameOf(main), names);
  writeGap({ ...readGap(), [id]: { names } });
  tellOwner(`built-in-tools:${id}`, words);
  postAgentNotice({
    toAgentId: main, fromName: 'Dojo message sent', intent: 'dojo_message_sent', selfIntro: false,
    brief: `The Dojo itself (not you) showed the owner this card on the owner's dashboard because ${nameOf(id)} (agent id ${id}) lacks tools its build lists: "${words}" `
      + `If he asks you to add them, call update_agent with agent_id "${id}" and grants {"tools":{"add":[${names.map((n) => `"${n}"`).join(',')}]}}: it only appends; names the agent already holds are left alone. `
      + `Do not repeat the card or claim it as your own words.`,
  });
  return true;
}
