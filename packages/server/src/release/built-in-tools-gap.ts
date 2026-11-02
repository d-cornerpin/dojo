// ════════════════════════════════════════════════════════════════════════════════════════
// TELLING THE OWNER WHAT A BUILT-IN AGENT LACKS (proof-fix-u), instead of guessing.
//
// `built-in-policy-delivery.ts` delivers the two names that joined the lists after the per-boot rewrite was retired,
// because no owner can have removed those. Older names (a PM from before 3.1.17 lacks `work_validate`) are a different
// question: an old list and an owner's trim of a newer list can be the same list, and the product records no edit that
// tells them apart (see `services/built-in-tools-card.ts`). An owner's removal must never be undone, so this pass edits
// NOTHING. For the Dreamer and the PM it finds what the current lists name that the row does not hold, records it once,
// raises one dashboard card, and tells the main agent the same words so it can add them if he asks.
//
// Idempotent: an agent already on the record is left as it is (a dismissal stands, a re-upgrade raises nothing new).
// A row that does not parse or an agent that holds everything raises nothing. An unreadable database throws, so the
// runner keeps the step owed.
// ════════════════════════════════════════════════════════════════════════════════════════

import { getDb } from '../db/connection.js';
import { getDreamerAgentId, getPMAgentId, getPrimaryAgentId } from '../config/platform.js';
import { DREAMER_TOOLS_POLICY } from '../vault/maintenance.js';
import { PM_ALLOWED_TOOLS } from '../tracker/pm-agent.js';
import { postAgentNotice } from '../agent/agent-notice.js';
import { gapWords, missingTools, readGap, writeGap } from '../services/built-in-tools-card.js';
import type { ReleaseStepOutcome } from './release-steps.js';

export function raiseBuiltInToolsGap(): ReleaseStepOutcome {
  const out: ReleaseStepOutcome = { examined: 0, flagged: 0, repaired: 0 };
  const db = getDb();
  const usual: Array<[string, readonly string[]]> = [
    [getPMAgentId(), PM_ALLOWED_TOOLS],
    [getDreamerAgentId(), (JSON.parse(DREAMER_TOOLS_POLICY) as { allow: string[] }).allow],
  ];
  const nameOf = (id: string): string => (db.prepare('SELECT name FROM agents WHERE id = ?').get(id) as { name: string | null } | undefined)?.name || id;
  for (const [id, list] of usual) {
    if (!db.prepare('SELECT 1 FROM agents WHERE id = ?').get(id)) continue;
    out.examined++;
    const record = readGap();
    if (record[id]) continue;                                       // already told (or dismissed): never again
    const names = missingTools(id, list);
    if (names.length === 0) continue;
    const main = getPrimaryAgentId();
    const words = gapWords(nameOf(id), nameOf(main), names);
    writeGap({ ...readGap(), [id]: { names, told: true } });
    out.flagged++;
    postAgentNotice({
      toAgentId: main, fromName: 'Dojo message sent', intent: 'dojo_message_sent', selfIntro: false,
      brief: `The Dojo itself (not you) showed the owner this card on his dashboard because ${nameOf(id)} (agent id ${id}) lacks tools its build lists: "${words}" `
        + `If he asks you to add them, read its current allow list with update_agent and send it back with these names added (grants.tools.allow). `
        + `Do not repeat the card or claim it as your own words.`,
    });
  }
  return out;
}
