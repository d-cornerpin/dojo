// v3.5 PLAN BEFORE PROJECT — the plan's structural check and its words, read on their own.
//
// checkPlan validates the parts a caller passes; renderPlan, planStepLine and tasksFromPlan write the text
// the project row and a task's board carry; taskPlanMismatch, explicitTasks and parsePlanJson pair the
// caller's tasks to the plan and read a stored plan back. The tracker tool drives these against a live
// project; here they are read directly, no database, so a wrong word is caught at the source.
import { describe, it, expect } from 'vitest';
import {
  checkPlan,
  explicitTasks,
  parsePlanJson,
  planStepLine,
  renderPlan,
  taskPlanMismatch,
  tasksFromPlan,
  type Plan,
} from '../plan.js';

// The plan every assertion shares: an approach and two steps.
const fixture: Plan = {
  approach: 'Sort it',
  steps: [
    { title: 'Count', how: 'search', done: 'count noted' },
    { title: 'Label', how: 'label pages', done: 'search returns 0' },
  ],
};

describe('checkPlan trims the text and keeps the shape', () => {
  it('a plan with padded text checks ok and comes back trimmed', () => {
    expect(checkPlan({ approach: ' Sort it ', steps: [{ title: ' Count ', how: ' search ', done: ' count noted ' }] }))
      .toEqual({ ok: true, plan: { approach: 'Sort it', steps: [{ title: 'Count', how: 'search', done: 'count noted' }] } });
  });
});

describe('checkPlan refuses a thing that is not a plan', () => {
  it.each([
    ['null', null],
    ['an array', []],
    ['a string', 'x'],
    ['a number', 5],
  ])('%s is refused, naming that no plan was passed', (_label, raw) => {
    expect(checkPlan(raw)).toMatchObject({ ok: false, error: expect.stringContaining('no plan was passed') });
  });

  it('an approach of only spaces is refused, naming plan.approach', () => {
    expect(checkPlan({ approach: '  ', steps: [] })).toMatchObject({ ok: false, error: expect.stringContaining('plan.approach') });
  });
  it('no steps is refused, naming plan.steps', () => {
    expect(checkPlan({ approach: 'a', steps: [] })).toMatchObject({ ok: false, error: expect.stringContaining('plan.steps') });
  });

  it.each([
    ['a step missing its done names its index and part', { approach: 'x', steps: [{ title: 't', how: 'h', done: 'd' }, { title: 't', how: 'h' }] }, 'plan.steps[1].done'],
    ['a step that is not an object names its index and part', { approach: 'x', steps: [null] }, 'plan.steps[0].title'],
  ])('%s', (_label, raw, part) => {
    expect(checkPlan(raw)).toMatchObject({ ok: false, error: expect.stringContaining(part) });
  });
});

describe('renderPlan', () => {
  it('writes the approach then one numbered line per step', () => {
    expect(renderPlan(fixture)).toBe(
      'Plan: Sort it\n1. Count: search (done when: count noted)\n2. Label: label pages (done when: search returns 0)',
    );
  });
});

describe('planStepLine', () => {
  it('names the step a task is on', () => {
    expect(planStepLine(fixture, 2)).toContain('Plan step 2 of 2');
  });
  it('is empty past the last step and for a step that has no number', () => {
    expect(planStepLine(fixture, 3)).toBe('');
    expect(planStepLine(fixture, 0)).toBe('');
  });
});

describe('tasksFromPlan', () => {
  it('makes one task per step, its how as the description and its done as the goal', () => {
    expect(tasksFromPlan(fixture).map((t) => [t.title, t.description, t.goal, t.stepNumber])).toEqual([
      ['Count', 'search', 'count noted', 1],
      ['Label', 'label pages', 'search returns 0', 2],
    ]);
  });
});

describe('taskPlanMismatch', () => {
  it('is null when the tasks and the steps pair up one to one', () => {
    expect(taskPlanMismatch(2, fixture)).toBeNull();
  });
  it('names both counts when they do not pair', () => {
    expect(taskPlanMismatch(1, fixture)).toContain('you passed 1 task and the plan has 2 plan steps');
  });
});

describe('explicitTasks', () => {
  it('is undefined when no entry has a title', () => {
    expect(explicitTasks([{ title: ' ' }, {}])).toBeUndefined();
  });
  it('is undefined when nothing was passed', () => {
    expect(explicitTasks(undefined)).toBeUndefined();
  });
  it('keeps the entries when one has a title', () => {
    expect(explicitTasks([{ title: 'x' }])).toEqual([{ title: 'x' }]);
  });
});

describe('parsePlanJson', () => {
  it('is null for nothing and for text that does not read back as a plan', () => {
    expect(parsePlanJson(null)).toBeNull();
    expect(parsePlanJson('{bad')).toBeNull();
    expect(parsePlanJson('{"approach":"a","steps":[]}')).toBeNull();
  });
  it('reads a stored plan back as a plan', () => {
    expect(parsePlanJson(JSON.stringify(fixture))).toEqual(fixture);
  });
});
