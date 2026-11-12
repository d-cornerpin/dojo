// Type-only imports: `tracker-store.ts` must not pull `plan.ts` (the measure registry) into the write path.
import type { Plan } from './plan.js';
export type { Plan };

export function planJson(plan: Plan, scrub: (s: string) => string): string {
  return JSON.stringify({
    approach: scrub(plan.approach),
    steps: plan.steps.map((s) => ({ ...s, title: scrub(s.title), how: scrub(s.how), done: scrub(s.done) })),
  });
}
