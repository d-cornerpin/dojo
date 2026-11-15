// Cross-turn attempt record: FAILING tool calls by canonical signature, in the DB, because the
// in-memory repeat rule sees only this turn and the one before, and dies with the process. Only failures are
// recorded (a SUCCEEDING repeat is routine, and a success clears the record); tool health
// itself is `tool-outcomes.ts`, which this function also feeds.

import { getDb } from '../../db/connection.js';
import { remedyNote } from '../../tools/error-remedies.js';
import { noteToolError } from './tool-error-ledger.js';
import { noteToolOutcome } from './tool-outcomes.js';

const CROSS_TURN_FAILURE_NOTE_THRESHOLD = 3;
// A failure streak older than this is stale history, not live circling.
const FAILURE_WINDOW_HOURS = 48;

/** Record a tool call's outcome; returns the cross-turn failure count (0 on success). Never throws. */
export function recordToolOutcome(
  agentId: string,
  toolName: string,
  signature: string,
  isError: boolean,
  errorText?: string | null,
): number {
  noteToolOutcome(agentId, toolName, isError, errorText);
  if (isError) noteToolError(agentId, toolName, errorText);
  try {
    const db = getDb();
    if (!isError) {
      db.prepare('DELETE FROM agent_tool_failures WHERE agent_id = ? AND signature = ?')
        .run(agentId, signature);
      return 0;
    }
    db.prepare(`
      INSERT INTO agent_tool_failures (agent_id, signature, tool_name)
      VALUES (?, ?, ?)
      ON CONFLICT(agent_id, signature) DO UPDATE SET
        hit_count = CASE
          WHEN last_at < datetime('now', '-${FAILURE_WINDOW_HOURS} hours') THEN 1
          ELSE hit_count + 1
        END,
        last_at = datetime('now'),
        updated_at = datetime('now')
    `).run(agentId, signature, toolName);
    const row = db.prepare(
      'SELECT hit_count FROM agent_tool_failures WHERE agent_id = ? AND signature = ?',
    ).get(agentId, signature) as { hit_count: number } | undefined;
    return row?.hit_count ?? 1;
  } catch {
    return 0;
  }
}

/** Advisory note once the cross-turn streak crosses the threshold, not a hard block:
 *  cross-turn identity has a higher false-positive risk than within-turn. */
export function crossTurnFailureNote(toolName: string, hitCount: number): string | null {
  if (hitCount < CROSS_TURN_FAILURE_NOTE_THRESHOLD) return null;
  return (
    `\n\n[Engine note: this exact ${toolName} call (same arguments) has now failed ` +
    `${hitCount} times across separate turns. Do not retry it as-is. Change the ` +
    `approach, or mark the task blocked and state exactly what is missing.]`
  );
}

/** A FAILING result's additions: the registered remedy, then the cross-turn note; else null. */
export function failureNotes(toolName: string, hitCount: number, errorText: string): string | null {
  return (remedyNote(toolName, errorText) + (crossTurnFailureNote(toolName, hitCount) ?? '')) || null;
}
