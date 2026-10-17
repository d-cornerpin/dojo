// ════════════════════════════════════════
// The per-(agent, tool) outcome record (t190, C1; migration 195).
//
// WHY IT EXISTS. `agent_tool_failures` (attempt-record.ts) is keyed by call SIGNATURE and is
// cleared only by an identical call, which is right for spotting circling and wrong for
// "is this tool healthy". One failed gmail_label on one email stayed an "unresolved failure"
// forever while the tool worked on every other email, and the status line told the agent so,
// four times, until it blocked itself. This record is keyed by TOOL: a success of the tool
// supersedes its earlier failure no matter which arguments either call used.
//
// WRITTEN on every tool result (`recordToolOutcome` calls `noteToolOutcome`). READ by the live
// status line (memory/integration-status-lane.ts) and the PM's block review
// (tracker/block-review-facts.ts). Best-effort: a recording fault never reaches the turn.
// ════════════════════════════════════════

import { getDb } from '../../db/connection.js';

/** Millisecond UTC, so a failure and a success in the same second still order. */
const NOW_MS = "strftime('%Y-%m-%d %H:%M:%f', 'now')";

export interface ToolOutcome {
  agentId: string;
  toolName: string;
  lastOkAt: string | null;
  lastFailAt: string | null;
  lastError: string | null;
  consecutiveFailures: number;
  totalFailures: number;
}

interface OutcomeRow {
  agent_id: string; tool_name: string; last_ok_at: string | null; last_fail_at: string | null;
  last_error: string | null; consecutive_failures: number; total_failures: number;
}

const fromRow = (r: OutcomeRow): ToolOutcome => ({
  agentId: r.agent_id, toolName: r.tool_name, lastOkAt: r.last_ok_at, lastFailAt: r.last_fail_at,
  lastError: r.last_error, consecutiveFailures: r.consecutive_failures, totalFailures: r.total_failures,
});

/** A failure is OPEN when the last thing recorded for the tool is that failure. A success
 *  resets the count to 0, so this is exactly "last failure newer than last success". */
export const isOpenFailure = (o: ToolOutcome): boolean => o.consecutiveFailures > 0;

/** Record one tool result. Success stamps `last_ok_at` and clears the streak; failure stamps
 *  `last_fail_at` with the error text and extends the streak. Never throws. */
export function noteToolOutcome(
  agentId: string, toolName: string, isError: boolean, errorText?: string | null,
): void {
  try {
    const db = getDb();
    if (!isError) {
      db.prepare(`
        INSERT INTO agent_tool_outcomes (agent_id, tool_name, last_ok_at)
        VALUES (?, ?, ${NOW_MS})
        ON CONFLICT(agent_id, tool_name) DO UPDATE SET
          last_ok_at = ${NOW_MS}, consecutive_failures = 0
      `).run(agentId, toolName);
      return;
    }
    const err = (errorText ?? '').trim().slice(0, 1000) || null;
    db.prepare(`
      INSERT INTO agent_tool_outcomes
        (agent_id, tool_name, last_fail_at, last_error, consecutive_failures, total_failures)
      VALUES (?, ?, ${NOW_MS}, ?, 1, 1)
      ON CONFLICT(agent_id, tool_name) DO UPDATE SET
        last_fail_at = ${NOW_MS}, last_error = excluded.last_error,
        consecutive_failures = consecutive_failures + 1, total_failures = total_failures + 1
    `).run(agentId, toolName, err);
  } catch { /* best-effort */ }
}

/** Every outcome row for an agent, newest activity first. Empty when unreadable. */
export function readToolOutcomes(agentId: string): ToolOutcome[] {
  try {
    return (getDb().prepare(
      `SELECT * FROM agent_tool_outcomes WHERE agent_id = ?
       ORDER BY MAX(COALESCE(last_ok_at, ''), COALESCE(last_fail_at, '')) DESC, tool_name`,
    ).all(agentId) as OutcomeRow[]).map(fromRow);
  } catch { return []; }
}
