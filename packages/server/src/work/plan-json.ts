// v3.5 PLAN BEFORE PROJECT: the plan as stored on the project row. A file of its own, with type-only
// imports, because `tracker-store.ts` (the door that writes the row) must not import `plan.ts`: that
// would pull the measure registry (and the Gmail client behind it) into the spine's write path.
import type { Plan } from './plan.js';
export type { Plan };

/** The plan as stored, every prose field passed through `scrub` (the door every prose column uses). */
export function planJson(plan: Plan, scrub: (s: string) => string): string {
  return JSON.stringify({
    approach: scrub(plan.approach),
    steps: plan.steps.map((s) => ({ ...s, title: scrub(s.title), how: scrub(s.how), done: scrub(s.done) })),
  });
}
