// An error loop is five errors inside two minutes. The count lives in SQL so a server restart
// cannot reset it: a crash loop is exactly the case that has to trip this brake.

import { getDb } from '../db/connection.js';
import { createLogger } from '../logger.js';

const logger = createLogger('error-loop-state');

/** The bound lives here so the count, the window and the storage have one owner. */
export const ERROR_LOOP_THRESHOLD = 5;

export const ERROR_LOOP_WINDOW_MS = 2 * 60 * 1000;

export interface ErrorLoopWindow {
  /** Errors inside the window for this agent, INCLUDING the one just recorded. */
  readonly count: number;
  readonly firstAtMs: number | null;
  /** `count >= ERROR_LOOP_THRESHOLD`. The whole verdict, so no caller re-derives it. */
  readonly tripped: boolean;
}

/** Record one error, then report this agent's window: prune, insert, count in one transaction.
 *  A reader between the prune and the insert would otherwise see a set that never existed. */
export function recordErrorInWindow(agentId: string, nowMs: number = Date.now()): ErrorLoopWindow {
  try {
    const db = getDb();
    return db.transaction((): ErrorLoopWindow => {
      db.prepare(
        "DELETE FROM error_loop_state WHERE agent_id = ? AND kind = 'error' AND at_ms <= ?",
      ).run(agentId, nowMs - ERROR_LOOP_WINDOW_MS);
      db.prepare(
        "INSERT INTO error_loop_state (agent_id, kind, at_ms) VALUES (?, 'error', ?)",
      ).run(agentId, nowMs);
      const row = db.prepare(
        "SELECT count(*) AS n, min(at_ms) AS first_at FROM error_loop_state WHERE agent_id = ? AND kind = 'error'",
      ).get(agentId) as { n: number; first_at: number | null } | undefined;
      const count = row?.n ?? 0;
      return { count, firstAtMs: row?.first_at ?? null, tripped: count >= ERROR_LOOP_THRESHOLD };
    })();
  } catch (err) {
    // An unreadable spine reports no loop: pausing an agent must never be taken from a state
    // nobody could read. The error still lands on `agents.last_error`; Healer detectors cover it.
    logger.error('error-loop window could not be recorded; NOT pausing on an unreadable spine', {
      agentId, error: err instanceof Error ? err.message : String(err),
    }, agentId);
    return { count: 0, firstAtMs: null, tripped: false };
  }
}

/** On a trip: keep the decision, clear the working state. The `'error'` rows go; one `'paused'`
 *  row stays with the numbers the decision was made on, the durable answer to why it paused. */
export function noteErrorLoopPause(agentId: string, window: ErrorLoopWindow, nowMs: number = Date.now()): void {
  try {
    const db = getDb();
    db.transaction(() => {
      db.prepare(
        "INSERT INTO error_loop_state (agent_id, kind, at_ms, detail) VALUES (?, 'paused', ?, ?)",
      ).run(agentId, nowMs, JSON.stringify({
        errorCount: window.count,
        windowMs: ERROR_LOOP_WINDOW_MS,
        threshold: ERROR_LOOP_THRESHOLD,
        firstErrorAtMs: window.firstAtMs,
      }));
      db.prepare("DELETE FROM error_loop_state WHERE agent_id = ? AND kind = 'error'").run(agentId);
    })();
  } catch (err) {
    logger.error('error-loop pause evidence could not be written', {
      agentId, error: err instanceof Error ? err.message : String(err),
    }, agentId);
  }
}

/** A clean turn ends the loop: the window is emptied, the evidence is not. */
export function clearErrorLoop(agentId: string): void {
  try {
    getDb().prepare("DELETE FROM error_loop_state WHERE agent_id = ? AND kind = 'error'").run(agentId);
  } catch (err) {
    logger.warn('error-loop window could not be cleared', {
      agentId, error: err instanceof Error ? err.message : String(err),
    }, agentId);
  }
}

export function errorLoopPauses(agentId: string): Array<{ atMs: number; detail: string | null }> {
  try {
    return getDb().prepare(
      "SELECT at_ms AS atMs, detail FROM error_loop_state WHERE agent_id = ? AND kind = 'paused' ORDER BY at_ms DESC",
    ).all(agentId) as Array<{ atMs: number; detail: string | null }>;
  } catch (err) {
    logger.warn('error-loop pause history could not be read', {
      agentId, error: err instanceof Error ? err.message : String(err),
    }, agentId);
    return [];
  }
}
