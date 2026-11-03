// ════════════════════════════════════════════════════════════════════════════════════════
// v3.5 field fix Y — THE BACKGROUND FOLDER: the launcher of the placeholder replacement
// (`uncondensed-placeholder.ts`) and the one release of the shared one-in-flight slot. Moved here whole in
// round 3 (its owners: the gate, the end of each turn, the boot's memory start, and the routine condense's release).
// See `catch-up-state.ts` for the catch-up it serves.
// ════════════════════════════════════════════════════════════════════════════════════════

import { getDb } from '../db/connection.js';
import { createLogger } from '../logger.js';
import { backgroundDrains } from '../agent/shared-state.js';
import { catchUpStands, endCatchUpIfDone, hasUncondensedPlaceholders } from './catch-up-state.js';
import { agentBusy } from './rebuild-signals.js';
import { eligibleSummaryWriters } from './summary-writer-health.js';
import { releaseChangedKeptRows, replaceUncondensedPlaceholders } from './uncondensed-placeholder.js';

const logger = createLogger('memory-uncondensed-placeholder');

function configuredModel(agentId: string): string | undefined {
  return (getDb().prepare('SELECT model_id FROM agents WHERE id = ?').get(agentId) as { model_id: string | null } | undefined)?.model_id ?? undefined;
}

/** THE BACKGROUND FOLDER'S LAUNCHER (the gate's, and the end of each turn's, `agent/runtime.ts`): one replacement per
 *  agent (sharing the routine condense's one-in-flight slot), only when a placeholder exists and some writer is
 *  answering. Field fix Y (`catch-up-state.ts`): it YIELDS to the agent's live turn — it does not start mid-turn and
 *  stops before its next note when one begins — and a pass that landed notes starts the next at once. */
export function replacePlaceholdersInBackground(agentId: string): boolean {
  try {
    releaseChangedKeptRows(agentId);   // t269 fix round 1: a kept-whole row that changed is a placeholder again
    endCatchUpIfDone(agentId);
    if (backgroundDrains.has(agentId) || !hasUncondensedPlaceholders(agentId) || agentBusy(agentId)) return false;
    if (eligibleSummaryWriters(configuredModel(agentId), agentId).length === 0) return false;   // none answering: no dial
  } catch {
    return false;   // a read that failed starts nothing; the gate never fails a turn over this
  }
  backgroundDrains.add(agentId);
  // Round 5: no clock of its own — a writer slower than the turn's patience finishes here. Round 7:
  // no turn cuts it either (a turn labels beside it); field fix Y: a turn beginning stops it BETWEEN notes.
  replaceUncondensedPlaceholders(agentId, { yieldTo: () => agentBusy(agentId) })
    .catch((err) => { logger.warn('Placeholder replacement failed', { error: err instanceof Error ? err.message : String(err) }, agentId); return 0; })
    .then((replaced) => {
      backgroundDrains.delete(agentId);
      endCatchUpIfDone(agentId);
      if (replaced > 0) replacePlaceholdersInBackground(agentId);   // the next when this one landed; none left, or mid-turn: no-op
    });
  return true;
}

/** THE SHARED ONE-IN-FLIGHT SLOT'S RELEASE for the routine condense (`context-gates.ts`), field fix Y r3 (F1): a job
 *  ending hands the slot on, so an open catch-up refused while it ran is never stranded. (The folder's own pass hands
 *  on above, after progress: a pass that landed nothing waits for a real signal rather than spinning.) */
export function releaseBackgroundSlot(agentId: string): void {
  backgroundDrains.delete(agentId);
  if (catchUpStands(agentId)) replacePlaceholdersInBackground(agentId);
}
