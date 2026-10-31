import { getDb } from '../db/connection.js';
import { writeTaskLog } from './task-log.js';
import { advanceBaseline } from './effort-governor.js';
import { reportEffortReviewStuckToOwner } from './pm-owner-report.js';

// THE PM'S EFFORT REVIEW, WHEN ITS VERDICT CANNOT BE USED. Split from `pm-agent.ts` (a size-ratchet file).

/** What was wrong with a reply that `parseEffortVerdict` could not use, in a sentence the PM can act on. */
export function whyUnusable(text: string | null | undefined): string {
  if (!text || !text.trim()) return 'the reply was empty';
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) return 'the reply was not a JSON object';
  try {
    const p = JSON.parse(match[0]) as Record<string, unknown>;
    const missing = [
      typeof p.advancing === 'boolean' ? null : '"advancing" (true or false)',
      typeof p.reason === 'string' ? null : '"reason" (text)',
      typeof p.task_id === 'string' ? null : '"task_id" (text)',
    ].filter((m): m is string => m !== null);
    return `the JSON object was missing or had the wrong type for ${missing.join(', ')}`;
  } catch {
    return 'the reply was not a valid JSON object';
  }
}

/** The reason of the last failed verdict on this request (failures since it was filed), and how many in a row. */
export function failedVerdictsOnThisRequest(taskId: string): { count: number; lastReason: string | null } {
  const rows = getDb().prepare(
    `SELECT json_extract(payload, '$.reason') AS reason FROM work_events
      WHERE work_id = ? AND kind = 'audit' AND json_extract(payload, '$.entry_kind') = 'effort_review_failed'
        AND id > COALESCE((SELECT MAX(id) FROM work_events WHERE work_id = ? AND kind = 'audit'
                             AND json_extract(payload, '$.entry_kind') = 'effort_review_requested'), 0)
      ORDER BY id DESC`,
  ).all(taskId, taskId) as Array<{ reason: string | null }>;
  return { count: rows.length, lastReason: rows[0]?.reason ?? null };
}

/**
 * A verdict that could not be used is a fact about THIS request: record it with its reason (the next
 * ask carries it). The second one in a row on the same request is not asked a third time: the owner
 * is told through the PM's own chat line, and the request is closed the way a verdict closes it.
 */
export function handFailedVerdict(taskId: string, title: string, assignedTo: string | null, reason: string): void {
  writeTaskLog({ taskId, fromEntity: 'pm', entryKind: 'effort_review_failed', reason });
  const { count } = failedVerdictsOnThisRequest(taskId);
  if (count < 2) return;
  reportEffortReviewStuckToOwner(taskId, title, assignedTo, reason);
  advanceBaseline(taskId);
}
