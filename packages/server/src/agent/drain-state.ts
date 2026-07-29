// ── THE DRAIN LADDERS, MADE RESTART-SAFE (PHASE-2 T10, RULING 5) ──
//
// Two drains in `runtime.ts` bound their own self-re-triggering by counting CONSECUTIVE
// passes that saw the same head without advancing it. Both kept that count in a
// module-scope `Map`, so **a crash loop reset the storm protection to zero on every boot** —
// the 2026-07-23 storm hazard wearing a different hat, on exactly the kind of box (lived-in,
// deep backlog) where it did the damage.
//
// T9 refused every column that already existed, each on its own measurement — `work.attempts`
// is the recurrence fire count, `messages.delivery_attempts` expires engine events, and a
// derivation from `turns` was refused BY THE BATTERY (`multi-agent-project` 0/3, run
// `bms651uo8lh`: it counts turns during which the drain was not looking at the head). The
// reasoning is preserved in full in `work/work-reaper.ts`'s landmine block and in migration
// `140_drain_state.sql`; this module is the home T9 said was owed.
//
// ── ONE STATEMENT, BECAUSE "CONSECUTIVE" IS THE WHOLE PROPERTY ──
//
// `bumpDrainLadder` is a single UPSERT that decides same-head-or-new-head IN SQL. Read-then-
// write in JS would give two drains racing on one agent a window to each read `stuck` and
// each write `stuck+1`, losing a pass — and a lost pass is a longer spin, which is the exact
// direction this bound exists to prevent.
//
// ── DIRECTION OF ERROR, STATED ──
//
// If the spine cannot be written, this returns a count ABOVE any caller's bound, so the drain
// stands DOWN. That is deliberate and it matches `selfWakeStandDown`'s own rule ("an
// unreadable spine returns stand down"): standing down costs a delayed wake, which the
// periodic sweeps then pick up; the other direction costs a storm.

import { getDb } from '../db/connection.js';
import { createLogger } from '../logger.js';

const logger = createLogger('drain-state');

/** The two drains, named. A third one has to declare itself here and in the migration's
 *  CHECK rather than quietly sharing another drain's counter. */
export type DrainKind = 'unserved_wake' | 'human_conversation';

/** What a caller gets when the spine cannot be read or written: stand down. Above every
 *  bound in the tree (2 for the unserved-wake drain, MAX_DRAIN_STUCK = 4 for the human one)
 *  without being a magic number either of them has to know about. */
export const DRAIN_LADDER_UNREADABLE = Number.MAX_SAFE_INTEGER;

/**
 * Record one drain pass over `head` and return how many CONSECUTIVE passes have now seen
 * that same head without it advancing. Zero on the first sighting — the Map's semantics,
 * preserved exactly, and now surviving a restart.
 */
export function bumpDrainLadder(agentId: string, drain: DrainKind, head: string): number {
  try {
    const row = getDb().prepare(`
      INSERT INTO drain_state (agent_id, drain, head, stuck, updated_at)
      VALUES (?, ?, ?, 0, ?)
      ON CONFLICT(agent_id, drain) DO UPDATE SET
        stuck      = CASE WHEN drain_state.head = excluded.head THEN drain_state.stuck + 1 ELSE 0 END,
        head       = excluded.head,
        updated_at = excluded.updated_at
      RETURNING stuck
    `).get(agentId, drain, head, Date.now()) as { stuck: number } | undefined;
    return row ? row.stuck : DRAIN_LADDER_UNREADABLE;
  } catch (err) {
    logger.error('drain ladder could not be recorded; standing the drain DOWN rather than spinning', {
      agentId, drain, head, error: err instanceof Error ? err.message : String(err),
    }, agentId);
    return DRAIN_LADDER_UNREADABLE;
  }
}

/** There is no head any more — nothing to drain. Clears the ladder so the next head starts
 *  at zero. (Also what a served or quarantined head does.) */
export function clearDrainLadder(agentId: string, drain: DrainKind): void {
  try {
    getDb().prepare('DELETE FROM drain_state WHERE agent_id = ? AND drain = ?').run(agentId, drain);
  } catch (err) {
    logger.warn('drain ladder could not be cleared', {
      agentId, drain, error: err instanceof Error ? err.message : String(err),
    }, agentId);
  }
}

/** Every ladder for one agent — a session reset clears both drains at once. */
export function clearAllDrainLadders(agentId: string): void {
  try {
    getDb().prepare('DELETE FROM drain_state WHERE agent_id = ?').run(agentId);
  } catch (err) {
    logger.warn('drain ladders could not be cleared', {
      agentId, error: err instanceof Error ? err.message : String(err),
    }, agentId);
  }
}

/** The ladder as stored. For diagnosis and for tests; the drains themselves only ever
 *  bump and clear, so they cannot read a value and then act on a stale copy of it. */
export function drainLadder(agentId: string, drain: DrainKind): { head: string; stuck: number } | null {
  try {
    return (getDb().prepare('SELECT head, stuck FROM drain_state WHERE agent_id = ? AND drain = ?')
      .get(agentId, drain) as { head: string; stuck: number } | undefined) ?? null;
  } catch {
    return null;
  }
}
