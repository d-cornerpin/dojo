// ── THE ERROR LOOP STOPS FORGETTING (PHASE-6 T10 Step 2) ──
//
// `agent/errors.ts` decides an agent is in an ERROR LOOP — five errors inside two minutes —
// and pauses it. Both halves of that decision lived in a module-scope
// `Map<string, {timestamp}[]>`, and both were broken by the same property:
//
//   * THE COUNT DIED WITH THE PROCESS. An error loop that takes the server down is the one
//     that matters most, and it reset the counter to zero on every boot — so a crash loop
//     could never trip the brake built to stop it. Same class as `drain_state` (migration
//     140), whose own header is the sentence this file is another instance of: a Map dies
//     with the process.
//   * THE DECISION LEFT NO EVIDENCE. On tripping, the old code paused the agent and then
//     `agentErrors.delete(agentId)` — the five records that JUSTIFIED the pause were
//     destroyed at the moment they became worth reading. The owner got `status = 'paused'`
//     and a chat notice; nothing durable said why, how many, or over what window.
//
// Migration `157_error_loop_state.sql` carries the table and the four alternatives that were
// measured and refused (`agents.last_error`, `work_events`, `audit_log`, `healer_state`).
//
// ── THE SEMANTICS ARE THE MAP'S, PRESERVED EXACTLY ──
//
// The old code filtered to the window, pushed now, compared against the threshold, and
// cleared on a trip. This does the same four things in SQL, in that order. Nothing was tuned:
// the threshold is still 5 and the window is still two minutes, and they are DECLARED here
// now instead of in `errors.ts` so that the count, the bound and the storage are one owner.
//
// ── DIRECTION OF ERROR, STATED ──
//
// If the spine cannot be read or written, this reports NO LOOP. Pausing an agent is the
// platform's most drastic engine-level action and it must never be taken from a state nobody
// could read; the error itself is still logged, still lands on `agents.last_error`, and the
// Healer's own stuck/error detectors are the backstop that does not depend on this table.
// The other direction — pausing an agent because a query failed — would take a working agent
// off the board on a transient DB error, which is a worse failure than a loop running one
// cycle longer.

import { getDb } from '../db/connection.js';
import { createLogger } from '../logger.js';

const logger = createLogger('error-loop-state');

/** Five errors is a loop. Carried verbatim from `agent/errors.ts`. */
export const ERROR_LOOP_THRESHOLD = 5;

/** …inside two minutes. Carried verbatim from `agent/errors.ts`. */
export const ERROR_LOOP_WINDOW_MS = 2 * 60 * 1000;

/** What one recorded error tells the caller about the loop it may be part of. */
export interface ErrorLoopWindow {
  /** Errors inside the window for this agent, INCLUDING the one just recorded. */
  readonly count: number;
  /** When the oldest error still inside the window happened; null when there is none. */
  readonly firstAtMs: number | null;
  /** `count >= ERROR_LOOP_THRESHOLD`. The whole verdict, so no caller re-derives it. */
  readonly tripped: boolean;
}

/**
 * Record one error and return the state of this agent's window.
 *
 * Prune → insert → count, in one transaction, because "five inside two minutes" is a property
 * of the SET and a reader between the prune and the insert would see a set that never existed.
 */
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
    // See "direction of error" above: an unreadable spine reports NO LOOP.
    logger.error('error-loop window could not be recorded; NOT pausing on an unreadable spine', {
      agentId, error: err instanceof Error ? err.message : String(err),
    }, agentId);
    return { count: 0, firstAtMs: null, tripped: false };
  }
}

/**
 * The trip: keep the DECISION, clear the working state.
 *
 * The `'error'` rows go — that is the Map's "reset after pausing", preserved — and one
 * `'paused'` row stays, carrying the numbers the decision was made on. It is the answer to
 * "why was my agent paused", which is the question the old code deleted before it could be
 * asked.
 */
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

/** Every error-loop pause this agent has had, newest first. The evidence, read back. */
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
