// v3.5 PLAN BEFORE PROJECT: reading a project's stored plan back (`work.plan_json`, migration 203).
// The write is `tracker-store.ts openTrackerProject`, the one door that inserts a project row.
import { getDb } from '../db/connection.js';
import { parsePlanJson, type Plan } from './plan.js';

/** The plan stored on a project row, or null (a dashboard project, or one opened before the plan existed). */
export function planOfProject(projectId: string): Plan | null {
  const row = getDb().prepare('SELECT plan_json FROM work WHERE id = ?').get(projectId) as { plan_json: string | null } | undefined;
  return parsePlanJson(row?.plan_json);
}
