// Is the work row this turn serves still there? Null is no row at all, not merely an unread kind.
import { getDb } from '../../db/connection.js';
import type { ServedWork } from '../turn-context.js';

// Readers stamp these ids onto turn records and approvals, and none of them re-checks.
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
