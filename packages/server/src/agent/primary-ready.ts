// ── THE RESIDENTS WAIT FOR THE PRIMARY, AND SAY SO WHEN THE WAIT IS NOT NORMAL ────────────
//
// Five permanent residents — PM, Trainer, Healer, Dreamer, Imaginer — cannot be created before
// the primary agent, because `agents.parent_agent` references it. Each carried its own copy of
// the same six lines: look for the primary, `logger.warn` if absent, `setTimeout(self, 5000)`,
// return.
//
// ── WHAT THAT COST (fresh-box audit, finding 3) ──
// On a box where `POST /api/setup/complete` ran without the primary ever being provisioned, all
// five deferred **on a 5-second loop, indefinitely** — 48 occurrences in minutes on the audited
// fresh box — at WARN, each line saying only "deferring". Nothing said the wait would never end,
// nothing named the cure, and the only thing that fixed it was a restart (the boot path creates
// the primary). A retry that cannot succeed is not a retry; it is a silence with a heartbeat.
//
// ── WHAT THIS ADDS ──
// The same wait, once, plus a CYCLE COUNT. The first few cycles are the normal case and stay at
// WARN — during a legitimate OOBE the primary appears within a cycle or two. Past `LOUD_AFTER`
// the wait has stopped being normal, so the line becomes an ERROR that names the cure. It keeps
// retrying rather than giving up: the condition really is curable from outside, and a resident
// that stopped waiting would need its own restart story.
//
// Per-caller counters, because five residents waiting once each is a different fact from one
// resident waiting five times, and the log should not blur them.

import { getDb } from '../db/connection.js';
import { createLogger } from '../logger.js';

const logger = createLogger('primary-ready');

/** Cycles of patience before the line changes register. 3 × 5s = ~15s, well past a real OOBE. */
const LOUD_AFTER = 3;

/** How long each resident has been waiting, by name. Reset the moment the primary appears. */
const waited = new Map<string, number>();

/**
 * Is the primary agent row there yet?
 *
 * `true`  — carry on; any wait this caller had recorded is forgotten.
 * `false` — the caller must return. The retry is already scheduled here, so a caller that
 *           ignores the `false` would double-schedule.
 *
 * @param who       the resident's name, for the log and for its own counter
 * @param primaryId the id `getPrimaryAgentId()` resolved
 * @param retry     how to try again — normally the caller's own ensure function
 */
export function primaryReady(who: string, primaryId: string, retry: () => void): boolean {
  const exists = getDb().prepare('SELECT id FROM agents WHERE id = ?').get(primaryId);
  if (exists) {
    waited.delete(who);
    return true;
  }

  const cycles = (waited.get(who) ?? 0) + 1;
  waited.set(who, cycles);

  if (cycles >= LOUD_AFTER) {
    // NAMES THE CURE, because the audited box logged 48 lines that named none.
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

  setTimeout(retry, 5_000);
  return false;
}

/** Test seam. Forgetting a count is always safe — the next cycle re-derives it. */
export function forgetPrimaryWait(who?: string): void {
  if (who === undefined) waited.clear();
  else waited.delete(who);
}
