import { WORK_MEASURE_REF_PROP } from './work-verb-schema.js';

type PropSchema = Record<string, unknown>;

// v3.5 PLAN BEFORE PROJECT — `plan` (work_open kind="project"). The agent writes it; the engine checks
// the parts are there (`work/plan.ts checkPlan`) and stores them on the project. `measure` is the same
// object a task carries, on the step that works a set of items.
export const WORK_PLAN_PROP: PropSchema = {
  type: 'object',
  description: 'Required for kind="project". Your plan, written before you start: approach (a few sentences: the shape of the work and why, including how you will do it at scale — see the scale facts in this tool\'s doc), and steps, each {title, how, done, measure?}. "how" names the tools and how many items per call; "done" says how you will know the step is finished. The engine makes one task per step with "how" as its instructions.',
  properties: {
    approach: { type: 'string' },
    steps: {
      type: 'array',
      minItems: 1,
      items: {
        type: 'object',
        properties: { title: { type: 'string' }, how: { type: 'string' }, done: { type: 'string' }, measure: WORK_MEASURE_REF_PROP },
        required: ['title', 'how', 'done'],
      },
    },
  },
  required: ['approach', 'steps'],
};
