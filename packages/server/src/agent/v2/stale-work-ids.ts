// "IS THAT WORK ROW STILL THERE?" for the work a turn serves: session context must not carry dead task ids.
import { getDb } from '../../db/connection.js';
import type { ServedWork } from '../turn-context.js';

/**
 * The work this turn serves — or `null`, which is a DIFFERENT fact from "served
 * work whose kind we could not read".
 *
 * The engine event carries a task referent; the pre-fix code read that row for
 * its kind and published the referent to turn-state EVEN WHEN THE READ CAME BACK
 * EMPTY, so a deleted task rode the whole turn as `{ taskId, taskKind: null }`.
 * Five readers take that map, and one of them refuses the agent's `imessage_send`
 * when the kind is `reminder`; another stamps the id onto the turn record, and a
 * third onto a destructive-approval row. None of them re-checks.
 */
export function resolveServedWork(
  taskId: string | null | undefined, runId: string | null | undefined,
): ServedWork | null {
  if (!taskId) return null;
  const row = getDb().prepare('SELECT task_kind AS kind, origin_conv_key FROM work WHERE id = ?')
    .get(taskId) as { kind: string | null; origin_conv_key: string | null } | undefined;
  if (!row) return null;
  return {
    taskId,
    runId: runId ?? null,
    taskKind: row.kind ?? null,
    originConvKey: row.origin_conv_key ?? null,
  };
}
