// v3.5 text wave — the work_update doc stops coaching closure (done-is-measured Part C3). Keeping
// on is the first status listed and "finished" the last; a task left in progress is described as
// what it is (it stays yours), never as a fault to be fixed before the turn ends.
import { describe, it, expect } from 'vitest';
import { toolDefinitions } from '../definitions.js';

const doc = (): string => toolDefinitions.find((t) => t.name === 'work_update')!.description;

describe('the work_update doc', () => {
  it('carries none of the closure coaching', () => {
    for (const s of ['NEVER leave a task in_progress', 'poke you after', 'DECISION MATRIX', 'pick exactly one', 'Do not end the turn']) {
      expect(doc()).not.toContain(s);
    }
  });

  it('lists keeping on first and finishing last, and says a task left in progress stays yours', () => {
    const d = doc();
    const head = d.indexOf('**action="status", when each status applies:**');
    expect(head).toBeGreaterThan(-1);
    const keepOn = d.indexOf('1. **You will take the next action on this work**');
    const finished = d.indexOf('4. **You finished the task, or it cannot be done** → action="hand_in"');
    expect(keepOn).toBeGreaterThan(head);
    expect(finished).toBeGreaterThan(d.indexOf('3. **You are blocked by something'));
    expect(d).toContain('**A task left in_progress at the end of a turn stays yours.**');
    expect(d).toContain('a scheduled run left in progress is recorded as not done, and its schedule goes on.');   // fix round 1 I-4
    expect(d).not.toMatch(/Close-outs are silent|want to abandon a project/);   // fix round 1 M-1
  });

  it('documents measure on edit, and the hand-in: proof, the measured rule and who decides', () => {
    expect(doc()).toContain('Pass `measure` to set or replace a task\'s measure; a new measure is a new scope, counted from now.');
    expect(doc()).toContain('A measured task is finished only when its measure reads 0.');
    expect(doc()).toContain('a hand-in with no real proof, or a "done" message alone, is refused');
    expect(doc()).toContain('someone other than you (the PM, else the main agent, else the owner)');
  });
});
