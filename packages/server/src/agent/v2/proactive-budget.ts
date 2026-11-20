// Consecutive proactive deliveries on settled-context wake turns, reset by an authorized owner inbound. At the
// threshold the closeout floor keeps the reply in chat and holds its push to the owner.
// Kept in the config table so the streak survives a restart; these keys are outside the cached config reader.
import { getDb } from '../../db/connection.js';
import { setConfigValue } from '../../config/config-value.js';
import { createLogger } from '../../logger.js';

const logger = createLogger('proactive-budget');

// 2 = the third consecutive proactive ping stays in chat and is not pushed.
export const PROACTIVE_SEND_DEMOTE_THRESHOLD = 2;

function streakKey(agentId: string): string {
  return `proactive_send_streak:${agentId}`;
}

/** Consecutive proactive settled-context deliveries since the owner last replied (0 if none). */
export function getProactiveSendStreak(agentId: string): number {
  try {
    const db = getDb();
    const row = db.prepare('SELECT value FROM config WHERE key = ?').get(streakKey(agentId)) as
      | { value: string }
      | undefined;
    const n = row?.value ? Number.parseInt(row.value, 10) : 0;
    return Number.isFinite(n) && n > 0 ? n : 0;
  } catch {
    return 0;
  }
}

export function bumpProactiveSendStreak(agentId: string): number {
  const next = getProactiveSendStreak(agentId) + 1;
  try {
    setConfigValue(streakKey(agentId), String(next));
  } catch (err) {
    logger.warn('bumpProactiveSendStreak failed (non-fatal)', {
      agentId, error: err instanceof Error ? err.message : String(err),
    }, agentId);
  }
  return next;
}

/** Reset the streak to zero (an authorized owner inbound arrived, or a new session). */
export function resetProactiveSendStreak(agentId: string): void {
  try {
    const db = getDb();
    db.prepare('DELETE FROM config WHERE key = ?').run(streakKey(agentId));
  } catch {
    /* best effort; a stale streak just means one extra demotion, never a lost reply */
  }
}
