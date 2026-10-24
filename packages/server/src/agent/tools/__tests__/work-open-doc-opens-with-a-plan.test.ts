// v3.5 text wave — plan before project, Part C1: the work_open doc and the tracker's standing line say
// a project opens with its plan. The old "just a title and a level" invitation not to plan is gone.
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { toolDefinitions } from '../definitions.js';

const doc = (name: string): string => toolDefinitions.find((t) => t.name === name)!.description;
const assemblerSrc = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'prompt', 'assembler.ts'), 'utf8');

describe('a project opens with its plan, in the words the agent reads', () => {
  it('the work_open doc', () => {
    expect(doc('work_open')).toContain('A project opens with its plan: write the approach and the steps (what, how at scale, how you know it is done) in `plan`; the engine makes the tasks from the steps.');
    expect(doc('work_open')).toContain('Think before you start: count first, work in pages, use a tool\'s batch form when it has one');
    expect(doc('work_open')).not.toContain('just a title and a level is enough');
  });
  it('the tracker standing line', () => {
    expect(assemblerSrc).toContain('Use the tracker for multi-step work. A project opens with your plan in it; follow the step on your board.');
  });
});
