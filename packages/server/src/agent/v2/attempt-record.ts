// ════════════════════════════════════════
// Cross-turn attempt record (remediation Phase 2, Invariant II).
//
// The in-memory loop detector catches circling WITHIN a turn; its state dies
// with the turn, so "tries the same broken thing once per wakeup, forever"
// was invisible. This records FAILING tool calls by canonical signature in
// the DB (durable means the DB; shared-state is process memory) and lets the
// loop surface a note when the same call keeps failing across turns.
//
// Only failures are recorded: an identical SUCCEEDING call across turns is
// routine (a daily email check has the same signature every day), not
// circling. A success clears the record for that signature.
// ════════════════════════════════════════

import { getDb } from '../../db/connection.js';

const CROSS_TURN_FAILURE_NOTE_THRESHOLD = 3;
// A failure streak older than this is stale history, not live circling.
const FAILURE_WINDOW_HOURS = 48;

/**
 * Record a tool call's outcome. Returns the cross-turn failure count for
 * this signature (0 on success or if recording failed). Best-effort: never
 * throws into the turn.
 */
export function recordToolOutcome(
  agentId: string,
  toolName: string,
  signature: string,
  isError: boolean,
): number {
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

/**
 * Advisory note appended to a failing tool result once the cross-turn streak
 * crosses the threshold. Advisory, not a hard block: cross-turn identity has
 * a higher false-positive risk than within-turn, so the engine informs and
 * the within-turn detector still owns hard blocking.
 */
export function crossTurnFailureNote(toolName: string, hitCount: number): string | null {
  if (hitCount < CROSS_TURN_FAILURE_NOTE_THRESHOLD) return null;
  return (
    `\n\n[Engine note: this exact ${toolName} call (same arguments) has now failed ` +
    `${hitCount} times across separate turns. Do not retry it as-is. Change the ` +
    `approach, or mark the task blocked and state exactly what is missing.]`
  );
}
