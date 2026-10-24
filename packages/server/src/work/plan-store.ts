// v3.5 PLAN BEFORE PROJECT: reading a project's stored plan back (`work.plan_json`, migration 203).
// The write is `tracker-store.ts openTrackerProject`, the one door that inserts a project row.
import { getDb } from '../db/connection.js';
import { parsePlanJson, planStepLine, type Plan } from './plan.js';

/** The plan stored on a project row, or null (a dashboard project, or one opened before the plan existed). */
export function planOfProject(projectId: string): Plan | null {
  const row = getDb().prepare('SELECT plan_json FROM work WHERE id = ?').get(projectId) as { plan_json: string | null } | undefined;
  return parsePlanJson(row?.plan_json);
}

/** The line of its project's plan a task is on ("Plan step 2 of 4 — …"), or null: no project, no plan, or no step number. */
export function planStepLineOf(taskId: string): string | null {
  const row = getDb().prepare(
    'SELECT p.plan_json AS plan_json, t.step_number AS step FROM work t JOIN work p ON p.id = t.parent_id WHERE t.id = ?',
  ).get(taskId) as { plan_json: string | null; step: number | null } | undefined;
  const plan = parsePlanJson(row?.plan_json);
  return plan && row?.step ? planStepLine(plan, row.step) || null : null;
}
