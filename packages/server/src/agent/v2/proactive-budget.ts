// ════════════════════════════════════════
// RC-5.3: proactive-send budget (backoff on unanswered background chatter)
// ════════════════════════════════════════
//
// Mailbox events wake the agent, and the floor model treats each wake as a social
// opening: over 24h of production it fired ~10 unprompted dashboard pings at a silent
// owner, several of them pure greeting filler, with no backoff (F-10). All the
// discouragement in the tree is prompt-level; NO counter persisted "N proactive sends
// since the owner last replied," so backoff was structurally impossible.
//
// This is that counter: consecutive user-facing deliveries on settled-context wake
// turns (settledContextWakeTurn && !deliberateSurfaceTurn), reset on any authorized
// owner inbound. At the threshold the terminal delivery block DEMOTES the outbound to a
// quiet notices-lane row (the working-note demote pattern) instead of sending, so the
// commentary is still visible in the dashboard but never pings. Deliberate surfaces
// (scheduler digests, reminders, completion reports) are exempt and never counted.
//
// Persisted in the config table (per agent) so the streak survives a restart. Direct
// SQL bypasses the cached platform-config reader (these keys are never in its key set).

import { getDb } from '../../db/connection.js';
import { createLogger } from '../../logger.js';

const logger = createLogger('proactive-budget');

// Demote once the agent has already made this many consecutive proactive deliveries on
// settled-context wakes with no owner reply in between. 2 = the third such ping in a row
// lands in the notices lane instead of pinging.
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

/** Increment the streak (a proactive settled-context delivery just happened); returns the new total. */
export function bumpProactiveSendStreak(agentId: string): number {
  const next = getProactiveSendStreak(agentId) + 1;
  try {
    const db = getDb();
    db.prepare(
      `INSERT INTO config (key, value, updated_at) VALUES (?, ?, datetime('now'))
         ON CONFLICT(key) DO UPDATE SET value = ?, updated_at = datetime('now')`,
    ).run(streakKey(agentId), String(next), String(next));
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
