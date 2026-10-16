// t181 — is an on_deck task unscheduled (nothing will bring it back)? Read by the active-tasks lane.
import { getDb } from '../db/connection.js';

/** t181: no schedule of any kind recorded on the row (a scheduled on_deck task is the scheduler's to bring back). */
export function unscheduled(id: string): boolean {
  try {
    return !!getDb().prepare(`SELECT 1 FROM work WHERE id = ? AND schedule_json IS NULL AND next_run_at IS NULL
      AND scheduled_start IS NULL AND repeat_interval IS NULL`).get(id);
  } catch { return false; }
}
