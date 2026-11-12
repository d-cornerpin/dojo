// Reads a project's stored plan (`work.plan_json`); `tracker-store.ts openTrackerProject` is the one writer.
import { getDb } from '../db/connection.js';
import { parsePlanJson, planStepLine, type Plan } from './plan.js';

export function planOfProject(projectId: string): Plan | null {
  const row = getDb().prepare('SELECT plan_json FROM work WHERE id = ?').get(projectId) as { plan_json: string | null } | undefined;
  return parsePlanJson(row?.plan_json);
}

/** The plan line of the step a task is on, or null when there is no project, plan or step number. */
export function planStepLineOf(taskId: string): string | null {
  const row = getDb().prepare(
    'SELECT p.plan_json AS plan_json, t.step_number AS step FROM work t JOIN work p ON p.id = t.parent_id WHERE t.id = ?',
  ).get(taskId) as { plan_json: string | null; step: number | null } | undefined;
  const plan = parsePlanJson(row?.plan_json);
  return plan && row?.step ? planStepLine(plan, row.step) || null : null;
}
