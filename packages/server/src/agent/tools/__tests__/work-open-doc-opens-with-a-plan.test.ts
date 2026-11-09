// v3.5 text wave — plan before project, Part C1: the work_open doc and the tracker's standing line say
// a project opens with its plan. The old "just a title and a level" invitation not to plan is gone.
import { describe, it, expect } from 'vitest';
import { toolDefinitions } from '../definitions.js';

const doc = (name: string): string => toolDefinitions.find((t) => t.name === name)!.description;

describe('a project opens with its plan, in the words the agent reads', () => {
  it('the work_open doc', () => {
    expect(doc('work_open')).toContain('A project opens with its plan: write the approach and the steps (what, how at scale, how you know it is done) in `plan`; the engine makes the tasks from the steps.');
    expect(doc('work_open')).toContain('Think before you start: count first, work in pages, use a tool\'s batch form when it has one');
    expect(doc('work_open')).not.toContain('just a title and a level is enough');
  });
  it('t262 parked: the tasks field, the tracker steers and the tracker reflex open a project with a plan', () => {
    const tasks = (toolDefinitions.find((t) => t.name === 'work_open')!.input_schema as { properties: { tasks: { description: string } } }).properties.tasks.description;
    expect(tasks).toBe('Project only. Optional: tasks of your own. Leave it out and the engine makes one task per plan step; if you pass it, give exactly one task per plan step, in step order.');
    expect(tasks).not.toContain('put down the FIRST');
  });
});
