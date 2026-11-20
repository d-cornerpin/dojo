// When the last dependency of a task finishes, its worker is woken with "the task is unblocked", unless the
// owner holds it: then nothing moves and nobody is told.
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../../db/connection.js', async () => (await import('./helpers/done-db.js')).connectionMock());
vi.mock('../../../gateway/ws.js', () => ({ broadcast: () => {}, stampPersistedRow: (e: unknown) => e }));
vi.mock('../../../agent/runtime.js', async () => (await import('./helpers/ladder-world.js')).runtimeMock());
vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 });

import { trackerRouter } from '../../../gateway/routes/tracker.js';
import { checkDependencies } from '../effects.js';
import { holdOf } from '../hold.js';
import { doneDb } from './helpers/done-db.js';
import { freshBoard, deliveredToOwner, stateOf, TASK, WORKER } from './helpers/decision-world.js';

const DEP = 'task-dep-0001';
const told = (): number => (doneDb().prepare(
  "SELECT COUNT(*) AS c FROM messages WHERE agent_id = ? AND lane = 'events' AND task_id = ? AND content LIKE '%is now unblocked%'",
).get(WORKER, TASK) as { c: number }).c;

beforeEach(() => {
  freshBoard();
  const at = Date.now() - 60_000;
  doneDb().prepare(
    `INSERT INTO work (id, kind, agent_id, requester, root_kind, root_id, state, intent, wakes, closes_thread, title, opened_at, closed_at, result_delivery_id, updated_at)
     VALUES (?, 'task', ?, 'owner', 'tracker', ?, 'done', 'task', 1, 0, 'Gather the figures', ?, ?, ?, ?)`,
  ).run(DEP, WORKER, DEP, at, at, deliveredToOwner(), at);
  doneDb().prepare("UPDATE work SET state = 'open', depends_on = ? WHERE id = ?").run(JSON.stringify([DEP]), TASK);
});

describe('an owner-held task is not told it is unblocked', () => {
  it('stays held and unmoved, and its worker is told nothing', async () => {
    expect((await trackerRouter.request(`/tasks/${TASK}`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ status: 'blocked' }) })).status).toBe(200);
    checkDependencies(DEP);
    await vi.dynamicImportSettled();
    expect(told()).toBe(0);
    expect(stateOf()).toBe('open');
    expect(holdOf(TASK)?.kind).toBe('blocked');
  });

  it('CONTROL: a task nobody holds moves and its worker is told', async () => {
    checkDependencies(DEP);
    await vi.dynamicImportSettled();
    expect(told()).toBe(1);
    expect(stateOf()).toBe('claimed');
  });
});
