// Every reference into `work(id)` is NO ACTION, so each delete path must clear all five by hand:
// work_events, work_ledger and adjudications rows are deleted; techniques.build_project_id and
// work.parent_id are nulled. A census test reads the five from `PRAGMA foreign_key_list`.

import { getDb } from '../db/connection.js';

/** The doomed set as a SELECT of ids, for a caller whose set is a predicate rather than a list. */
export interface WorkIdSelect { sql: string; params: readonly unknown[] }

/** Clear every reference into `workIds`; the caller deletes the rows, inside its own `withUnit`.
 *  A no-op on an empty list, so an empty `IN ()` is never built. */
export function clearReferencesToWork(workIds: readonly string[] | WorkIdSelect): void {
  const sel = Array.isArray(workIds)
    ? { sql: (workIds as readonly string[]).map(() => '?').join(','), params: workIds as readonly unknown[] }
    : workIds as WorkIdSelect;
  if (Array.isArray(workIds) && workIds.length === 0) return;
  const db = getDb();
  const { sql: ph, params } = sel;
  db.prepare(`DELETE FROM work_events WHERE work_id IN (${ph})`).run(...params);
  db.prepare(`DELETE FROM adjudications WHERE work_id IN (${ph})`).run(...params);
  db.prepare(`DELETE FROM work_ledger WHERE work_id IN (${ph})`).run(...params);
  db.prepare(`UPDATE techniques SET build_project_id = NULL WHERE build_project_id IN (${ph})`).run(...params);
  db.prepare(`UPDATE work SET parent_id = NULL WHERE parent_id IN (${ph})`).run(...params);
}
