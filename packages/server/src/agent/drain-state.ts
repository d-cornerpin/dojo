// The drain ladders live in SQLite, so a crash loop cannot reset the storm protection on every boot.
// bumpDrainLadder is one UPSERT that decides in SQL whether the head is the same or new: read and write
// together, so two drains racing on one agent never each write stuck+1 from one read and lose a pass.
// An unwritable spine returns a count above every caller's bound: stand down; a delayed wake beats a storm.
// Its own table: work.attempts, messages.delivery_attempts and a turns count each measure something else.

import { getDb } from '../db/connection.js';
import { createLogger } from '../logger.js';

const logger = createLogger('drain-state');

// A third drain declares itself here and in the migration's CHECK; it never shares another drain's counter.
export type DrainKind = 'unserved_wake' | 'human_conversation';

// The stand-down value: above every bound in the tree, so neither drain needs the other's number.
export const DRAIN_LADDER_UNREADABLE = Number.MAX_SAFE_INTEGER;

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

// No head left: clear so the next head starts at zero. A served or quarantined head clears it too.
export function clearDrainLadder(agentId: string, drain: DrainKind): void {
  try {
    getDb().prepare('DELETE FROM drain_state WHERE agent_id = ? AND drain = ?').run(agentId, drain);
  } catch (err) {
    logger.warn('drain ladder could not be cleared', {
      agentId, drain, error: err instanceof Error ? err.message : String(err),
    }, agentId);
  }
}

export function clearAllDrainLadders(agentId: string): void {
  try {
    getDb().prepare('DELETE FROM drain_state WHERE agent_id = ?').run(agentId);
  } catch (err) {
    logger.warn('drain ladders could not be cleared', {
      agentId, error: err instanceof Error ? err.message : String(err),
    }, agentId);
  }
}

// For diagnosis and tests only: the drains only bump and clear, so they never act on a stale read.
export function drainLadder(agentId: string, drain: DrainKind): { head: string; stuck: number } | null {
  try {
    return (getDb().prepare('SELECT head, stuck FROM drain_state WHERE agent_id = ? AND drain = ?')
      .get(agentId, drain) as { head: string; stuck: number } | undefined) ?? null;
  } catch {
    return null;
  }
}
