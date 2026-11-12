// The plan an agent writes into a project when it opens one: the engine only checks the parts are there
// and stores them (no refusal on content). Pure: `tracker-store.ts` writes `work.plan_json`,
// `plan-store.ts` reads it back.
import { parseMeasure, type Measure } from './measure.js';
export { planJson } from './plan-json.js';

export interface PlanStep { title: string; how: string; done: string; measure?: Measure }
export interface Plan { approach: string; steps: PlanStep[] }

const text = (v: unknown): string => (typeof v === 'string' ? v.trim() : '');

/** The caller's own tasks when it passed any with a title; otherwise none (untitled entries are no tasks). */
export function explicitTasks<T extends { title?: unknown }>(raw: readonly T[] | undefined): T[] | undefined {
  return raw?.some((t) => typeof t?.title === 'string' && t.title.trim().length > 0) ? [...raw] : undefined;
}

/** Tasks and plan passed together must pair up, one task per step in step order (the task board shows a
 *  task its own step); null when they do. */
export function taskPlanMismatch(tasks: number, plan: Plan): string | null {
  if (tasks === plan.steps.length) return null;
  const n = (c: number, w: string): string => `${c} ${w}${c === 1 ? '' : 's'}`;
  return `you passed ${n(tasks, 'task')} and the plan has ${n(plan.steps.length, 'plan step')}; the plan's steps are the tasks, so leave out \`tasks\` and the engine makes one per step, or pass exactly one task per step, in step order`;
}

/** The structural check: an approach, and at least one step with a title, a how and a done. */
export function checkPlan(raw: unknown): { ok: true; plan: Plan } | { ok: false; error: string } {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { ok: false, error: 'no plan was passed (plan must be an object {approach, steps})' };
  const o = raw as Record<string, unknown>;
  const approach = text(o.approach);
  if (!approach) return { ok: false, error: 'plan.approach is missing (a few sentences: the shape of the work and why)' };
  if (!Array.isArray(o.steps) || o.steps.length === 0) return { ok: false, error: 'plan.steps is missing (at least one step: {title, how, done})' };
  const steps: PlanStep[] = [];
  for (let i = 0; i < o.steps.length; i++) {
    const s = o.steps[i];
    const rec = s && typeof s === 'object' ? s as Record<string, unknown> : {};
    for (const part of ['title', 'how', 'done'] as const) {
      if (!text(rec[part])) return { ok: false, error: `plan.steps[${i}].${part} is missing${part === 'how' ? ' (which tools, and how many items per call)' : part === 'done' ? ' (how you will know the step is finished)' : ''}` };
    }
    const step: PlanStep = { title: text(rec.title), how: text(rec.how), done: text(rec.done) };
    if (rec.measure !== undefined && rec.measure !== null) {
      const m = parseMeasure(rec.measure);
      if (!m.ok) return { ok: false, error: `plan.steps[${i}].measure: ${m.error}` };
      step.measure = m.measure;
    }
    steps.push(step);
  }
  return { ok: true, plan: { approach, steps } };
}

/** The text stored as the project's description and printed back by `work_update(action="get")`. */
export function renderPlan(plan: Plan): string {
  const steps = plan.steps.map((s, i) => `${i + 1}. ${s.title}: ${s.how} (done when: ${s.done})`);
  return `Plan: ${plan.approach}\n${steps.join('\n')}`;
}

export function planStepLine(plan: Plan, stepNumber: number): string {
  const s = plan.steps[stepNumber - 1];
  return s ? `Plan step ${stepNumber} of ${plan.steps.length} — ${s.title}: ${s.how} (done when: ${s.done})` : '';
}

/** The tasks a plan makes: one per step, its `how` as the instructions and its `done` as the goal. */
export function tasksFromPlan(plan: Plan): Array<{ title: string; description: string; goal: string; stepNumber: number; measure?: Measure }> {
  return plan.steps.map((s, i) => ({ title: s.title, description: s.how, goal: s.done, stepNumber: i + 1, ...(s.measure ? { measure: s.measure } : {}) }));
}

/** A stored plan, or null for no plan / one that does not read back as a plan. */
export function parsePlanJson(raw: string | null | undefined): Plan | null {
  if (!raw) return null;
  try {
    const r = checkPlan(JSON.parse(raw));
    return r.ok ? r.plan : null;
  } catch { return null; }
}

export const PLAN_REFUSAL_PREFIX = 'Refused: a project opens with its plan';

/** The refusal for a project opened without a usable plan: the three required parts and a one-step example. */
export function planRefusal(error: string): string {
  return `${PLAN_REFUSAL_PREFIX} (${error}). Pass plan={approach, steps:[{title, how, done}]}. ` +
    'Example: plan={approach:"Count what matches, then work in pages: one search of 500, then label calls of up to 1,000 ids each.", ' +
    'steps:[{title:"Count", how:"gmail_search with the query, max_results 1, read the total", done:"the count is noted on the task"}, ' +
    '{title:"Label in pages", how:"gmail_search 500 per page; gmail_label with message_ids (up to 1,000) per batch", done:"the search returns 0", ' +
    'measure:{tool:"gmail_search", args:{query:"…"}}}]}';
}
