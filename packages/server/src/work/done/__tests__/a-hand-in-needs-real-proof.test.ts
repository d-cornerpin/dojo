// The hand-in door: finished or can't be done, with proof items that pass the one proof check. A status
// claim is never proof, a weak model's old close habit reaches this same door, and a project with open
// tasks is handed in only as can't be done, its decision closing them.
import { describe, it, expect, vi } from 'vitest';

vi.mock('../../../db/connection.js', async () => (await import('./helpers/done-db.js')).connectionMock());
vi.mock('../../../gateway/ws.js', () => ({ broadcast: () => {}, stampPersistedRow: (e: unknown) => e }));
vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 });

import { freshBoard, deliveredToOwner, call, stateOf, eventCount, PM, WORKER, OTHER, TASK } from './helpers/decision-world.js';
import { doneDb } from './helpers/done-db.js';

describe('a hand-in needs real proof', () => {
  it('a hand-in whose proof is a status claim is refused, counted, and moves nothing', async () => {
    freshBoard();
    const r = await call(WORKER, 'work_update', { action: 'hand_in', task_id: TASK, outcome: 'finished', proof: [{ kind: 'delivery', ref: 'task complete, please validate' }], note: 'done' });
    expect(r.isError).toBe(true);
    expect(r.content).toContain('task complete, please validate');
    expect(stateOf()).toBe('claimed');
    expect(eventCount('hand_in_refused')).toBe(1);
  });

  it('an old work_update(status="complete") call reaches the hand-in door and is refused without proof', async () => {
    freshBoard();
    const r = await call(WORKER, 'work_update', { action: 'status', task_id: TASK, status: 'complete' });
    expect(r.isError).toBe(true);
    expect(r.content).toMatch(/no proof items/);
    expect(stateOf()).toBe('claimed');
    expect(eventCount('hand_in_refused')).toBe(1);
  });

  it('a refused hand-in names the records on file the worker may cite', async () => {
    freshBoard();
    const d = deliveredToOwner();
    const r = await call(WORKER, 'work_update', { action: 'hand_in', task_id: TASK, outcome: 'finished', proof: [], note: 'sent it' });
    expect(r.isError).toBe(true);
    expect(r.content).toContain(`ref:"${d}"`);
  });

  it('another agent cannot hand in the worker\'s task', async () => {
    freshBoard();
    const d = deliveredToOwner();
    const r = await call(OTHER, 'work_update', { action: 'hand_in', task_id: TASK, outcome: 'finished', proof: [{ kind: 'delivery', ref: d }], note: 'sent it' });
    expect(r.isError).toBe(true);
    expect(stateOf()).toBe('claimed');
    expect(eventCount('hand_in_refused')).toBe(0);
  });

  it('a hand-in with real proof moves the task to handed in, carrying its items, and it is not done', async () => {
    freshBoard();
    const d = deliveredToOwner();
    const r = await call(WORKER, 'work_update', { action: 'hand_in', task_id: TASK, outcome: 'finished', proof: [{ kind: 'delivery', ref: d }], note: 'Report sent to the owner' });
    expect(r.isError).toBe(false);
    expect(r.content).toMatch(/not done yet/);
    expect(stateOf()).toBe('handed_in');
    const ev = doneDb().prepare("SELECT payload FROM work_events WHERE work_id = ? AND kind = 'handed_in'").get(TASK) as { payload: string };
    expect(JSON.parse(ev.payload)).toMatchObject({ outcome: 'finished', items: [{ kind: 'delivery', ref: d }] });
  });

  it('a project with an open task is not handed in as finished; handed in as can\'t be done, its decision closes the task', async () => {
    freshBoard();
    const at = Date.now() - 60_000;
    doneDb().prepare(
      `INSERT INTO work (id, kind, agent_id, requester, root_kind, root_id, state, intent, wakes, closes_thread, title, opened_at, updated_at)
       VALUES ('proj-1', 'project', ?, 'owner', 'tracker', 'proj-1', 'open', 'task', 1, 0, 'Quarterly report', ?, ?)`,
    ).run(WORKER, at, at);
    doneDb().prepare("UPDATE work SET parent_id = 'proj-1' WHERE id = ?").run(TASK);
    const d = deliveredToOwner();
    const r = await call(WORKER, 'work_update', { action: 'close_project', project_id: 'proj-1', proof: [{ kind: 'delivery', ref: d }], note: 'All sent' });
    expect(r.content).toMatch(/1 open task is not finished/);
    const cant = await call(WORKER, 'work_update', { action: 'hand_in', project_id: 'proj-1', outcome: 'cant_be_done', proof: [{ kind: 'remainder', ref: 'the second quarter', reason: 'the owner dropped the second quarter from scope' }], note: 'Scope cut' });
    expect(cant.content).toMatch(/1 open task closes with it/);
    await call(PM, 'work_validate', { action: 'open_proof', task_id: 'proj-1', item: 0 });
    const dec = await call(PM, 'work_validate', { action: 'decide', task_id: 'proj-1', verdict: 'approve', reason: 'The owner cut the scope' });
    expect(dec.isError, dec.content).toBe(false);
    expect(stateOf('proj-1')).toBe('failed');
    expect(stateOf()).toBe('failed');
  });
});
