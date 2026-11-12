// Per-(agent, tool) outcome record. Keyed by TOOL, unlike the per-signature `agent_tool_failures`
// (attempt-record.ts): any success of a tool supersedes its earlier failure, whatever the arguments.
// Written by `recordToolOutcome` on every result; read by memory/integration-status-lane.ts. Best-effort.

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
