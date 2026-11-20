// The goal and the measure of a task are its creator's: the agent working a task another agent gave it cannot
// change them; the main agent can, and its change is on the record with who made it.
import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../../../db/connection.js', async () => (await import('./helpers/done-db.js')).connectionMock());
vi.mock('../../../gateway/ws.js', () => ({ broadcast: () => {}, stampPersistedRow: (e: unknown) => e }));
vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 });

import { doneDb } from './helpers/done-db.js';
import { freshBoard, call, MAIN, WORKER, TASK } from './helpers/decision-world.js';
import { editMeasure, type MeasureReading } from '../../../tracker/measure-gate.js';
import { trackerCreateTask } from '../../../tracker/tools.js';

const READING: MeasureReading = { measure: { tool: 'gmail_search', args: { query: 'in:inbox' }, unit: 'messages' }, count: { ok: true, count: 3 }, at: Date.now() };
const goal = (): string => (doneDb().prepare('SELECT goal FROM work WHERE id = ?').get(TASK) as { goal: string }).goal;
const measured = (id = TASK): Array<{ set_by?: string; at_open?: true }> =>
  (doneDb().prepare("SELECT payload FROM work_events WHERE work_id = ? AND kind = 'measured'").all(id) as Array<{ payload: string }>)
    .map((e) => JSON.parse(e.payload));
const editGoal = (as: string) => call(as, 'work_update', { action: 'edit', task_id: TASK, goal: 'Any report at all' });

beforeEach(() => {
  freshBoard();
  doneDb().prepare("UPDATE work SET requester = 'agent', requester_id = ? WHERE id = ?").run(MAIN, TASK);
});

describe('a helper cannot change the goal or the measure it was given', () => {
  it('the worker is refused the goal, and the goal is unchanged', async () => {
    const r = await editGoal(WORKER);
    expect(r.content).toContain('belong to whoever gave you the work, so you cannot change them.');
    expect(goal()).toBe('The owner has the report');
  });

  it('the worker sending the unchanged goal back with another edit is not refused', async () => {
    const r = await call(WORKER, 'work_update', { action: 'edit', task_id: TASK, goal: 'The owner has the report', title: 'The report, final' });
    expect(r.content).not.toMatch(/^Error/);
    expect((doneDb().prepare('SELECT title FROM work WHERE id = ?').get(TASK) as { title: string }).title).toBe('The report, final');
  });

  it('the main agent changes the goal, and the change is logged as its own', async () => {
    expect((await editGoal(MAIN)).content).not.toMatch(/^Error/);
    expect(goal()).toBe('Any report at all');
    const log = doneDb().prepare("SELECT actor FROM work_events WHERE work_id = ? AND kind = 'audit'").all(TASK) as Array<{ actor: string }>;
    expect(log.map((e) => e.actor)).toContain(`agent:${MAIN}`);
  });

  it('the main agent holding a task the owner gave it changes the goal and the measure', async () => {
    doneDb().prepare("UPDATE work SET requester = 'owner', requester_id = NULL, agent_id = ?, assignee_agent = ? WHERE id = ?").run(MAIN, MAIN, TASK);
    expect((await editGoal(MAIN)).content).not.toMatch(/^Error/);
    expect(goal()).toBe('Any report at all');
    expect(editMeasure(MAIN, TASK, READING)).toHaveProperty('line');
  });

  it('a worker that created its own task may change its goal', async () => {
    doneDb().prepare('UPDATE work SET requester_id = ? WHERE id = ?').run(WORKER, TASK);
    expect((await editGoal(WORKER)).content).not.toMatch(/^Error/);
    expect(goal()).toBe('Any report at all');
  });

  it('the worker is refused the measure; the main agent sets it and the record names who set it', () => {
    expect(editMeasure(WORKER, TASK, READING)).toMatchObject({ error: expect.stringContaining('you cannot change them') });
    expect(measured()).toEqual([]);
    expect(editMeasure(MAIN, TASK, READING)).toHaveProperty('line');
    expect(measured().map((m) => [m.set_by, m.at_open])).toEqual([[MAIN, undefined]]);
  });

  it('a measure set when the task is made records its setter and that it came with the opening', async () => {
    await trackerCreateTask(MAIN, { title: 'Clear the support inbox', goal: 'The support inbox reads empty' }, { measure: READING });
    const made = doneDb().prepare("SELECT id FROM work WHERE title = 'Clear the support inbox'").get() as { id: string };
    expect(measured(made.id).map((m) => [m.set_by, m.at_open])).toEqual([[MAIN, true]]);
  });
});
