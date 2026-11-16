// Residents wait for the primary agent (their parent row). Counters are per-caller:
// five residents waiting once is a different fact from one resident waiting five times.

import { getDb } from '../db/connection.js';
import { createLogger } from '../logger.js';

const logger = createLogger('primary-ready');

const LOUD_AFTER = 3;

const waited = new Map<string, number>();
const pending = new Set<string>();   // one retry per caller: every work_open asks again, and each retry re-arms itself

/** true: carry on; any wait recorded for this caller is forgotten.
 *  false: the caller MUST return; a retry is scheduled (only one per caller is ever pending). */
export function primaryReady(who: string, primaryId: string, retry: () => void): boolean {
  const exists = getDb().prepare('SELECT id FROM agents WHERE id = ?').get(primaryId);
  if (exists) {
    waited.delete(who);
    return true;
  }

  const cycles = (waited.get(who) ?? 0) + 1;
  waited.set(who, cycles);

  if (cycles >= LOUD_AFTER) {
    logger.error(
      `${who} still cannot start: the primary agent does not exist, and this has been retried ` +
      `${cycles} times (~${cycles * 5}s). This box completed setup without provisioning a ` +
      'primary agent, so no agent can be created. CURE: provision it — the dashboard\'s setup ' +
      'step, or POST /api/setup/provision-agent — or restart the server, whose boot path creates ' +
      'it. Retrying every 5s until then.',
      { who, primaryId, cycles },
    );
  } else {
    logger.warn(`Primary agent not yet created, deferring ${who} spawn`, { primaryId, cycles });
  }

  if (!pending.has(who)) {
    pending.add(who);
    setTimeout(() => { pending.delete(who); retry(); }, 5_000);
  }
  return false;
}
