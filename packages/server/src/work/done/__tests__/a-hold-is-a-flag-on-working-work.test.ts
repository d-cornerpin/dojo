// Paused and blocked are holds on Working work, never states and never a way out: a held task keeps
// its state, needs no verdict, is still handed in and decided, and the owner holds and lifts it from
// the dashboard. A recurring task waits between runs as Open, and its schedule pauses on its own flag.
import { describe, it, expect, vi } from 'vitest';

vi.mock('../../../db/connection.js', async () => (await import('./helpers/done-db.js')).connectionMock());
vi.mock('../../../gateway/ws.js', () => ({ broadcast: () => {}, stampPersistedRow: (e: unknown) => e }));
vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 });

import { trackerRouter } from '../../../gateway/routes/tracker.js';
import { getTask } from '../../../tracker/schema.js';
import { holdOf } from '../hold.js';
import { freshBoard, deliveredToOwner, call, stateOf, eventCount, WORKER, TASK } from './helpers/decision-world.js';
import { doneDb } from './helpers/done-db.js';

const holdEntries = (): number => (doneDb().prepare(
  "SELECT COUNT(*) AS c FROM work_events WHERE work_id = ? AND kind = 'audit' AND json_extract(payload, '$.entry_kind') IN ('hold_set', 'hold_cleared')",
).get(TASK) as { c: number }).c;

const put = (body: Record<string, unknown>) => trackerRouter.request(`/tasks/${TASK}`, {
  method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
});

describe('a hold is a flag on Working work', () => {
  it('paused holds the task with its reason, and the task stays Working', async () => {
    freshBoard();
    const r = await call(WORKER, 'work_update', { action: 'status', task_id: TASK, status: 'paused', notes: 'waiting for the owner to send the logo' });
    expect(r.isError).toBe(false);
    expect(stateOf()).toBe('claimed');
    expect(holdOf(TASK)).toMatchObject({ kind: 'paused', reason: 'waiting for the owner to send the logo' });
    expect(holdEntries()).toBe(1);
    expect(getTask(TASK)).toMatchObject({ status: 'in_progress', hold: 'paused', holdReason: 'waiting for the owner to send the logo' });
  });

  it('a hold without a reason is refused', async () => {
    freshBoard();
    const r = await call(WORKER, 'work_update', { action: 'status', task_id: TASK, status: 'blocked' });
    expect(r.content).toMatch(/requires a clear reason/);
    expect(holdOf(TASK)).toBeNull();
  });

  it('a blocked hold needs no verdict and files nothing for the PM', async () => {
    freshBoard();
    await call(WORKER, 'work_update', { action: 'status', task_id: TASK, status: 'blocked', notes: 'need the API key for the vendor' });
    expect(holdOf(TASK)?.kind).toBe('blocked');
    const filed = doneDb().prepare("SELECT kind FROM work_events WHERE work_id = ? AND kind <> 'audit'").all(TASK);
    expect(filed).toEqual([]);
    expect((doneDb().prepare('SELECT COUNT(*) AS c FROM adjudications WHERE work_id = ?').get(TASK) as { c: number }).c).toBe(0);
  });

  it('in_progress lifts the hold', async () => {
    freshBoard();
    await call(WORKER, 'work_update', { action: 'status', task_id: TASK, status: 'paused', notes: 'waiting for the owner to reply' });
    const r = await call(WORKER, 'work_update', { action: 'status', task_id: TASK, status: 'in_progress' });
    expect(r.isError).toBe(false);
    expect(holdOf(TASK)).toBeNull();
    expect(stateOf()).toBe('claimed');
    expect(holdEntries()).toBe(2);
  });

  it('a held task is still handed in, and the hold ends at the hand-in', async () => {
    freshBoard();
    await call(WORKER, 'work_update', { action: 'status', task_id: TASK, status: 'blocked', notes: 'the vendor portal is down' });
    const d = deliveredToOwner();
    const r = await call(WORKER, 'work_update', { action: 'hand_in', task_id: TASK, outcome: 'finished', proof: [{ kind: 'delivery', ref: d }], note: 'Report sent to the owner' });
    expect(r.isError).toBe(false);
    expect(stateOf()).toBe('handed_in');
    expect(eventCount('handed_in')).toBe(1);
    expect(holdOf(TASK)).toBeNull();
  });

  it('on_deck means Open, and a recurring task\'s schedule pauses on its own flag without moving the task', async () => {
    freshBoard();
    doneDb().prepare("UPDATE work SET repeat_interval = 1, repeat_unit = 'days', schedule_status = 'waiting', next_run_at = ? WHERE id = ?")
      .run(Date.now() + 3_600_000, TASK);
    await call(WORKER, 'work_update', { action: 'status', task_id: TASK, status: 'on_deck' });
    expect(stateOf()).toBe('open');
    const r = await call(WORKER, 'work_schedule', { action: 'pause', task_id: TASK });
    expect(r.isError).toBe(false);
    const row = doneDb().prepare('SELECT state, is_paused, hold_kind FROM work WHERE id = ?').get(TASK);
    expect(row).toEqual({ state: 'open', is_paused: 1, hold_kind: null });
  });

  it('the owner pauses and resumes from the dashboard', async () => {
    freshBoard();
    expect((await put({ status: 'paused' })).status).toBe(200);
    expect(holdOf(TASK)?.kind).toBe('paused');
    expect(stateOf()).toBe('claimed');
    expect((await put({ status: 'in_progress' })).status).toBe(200);
    expect(holdOf(TASK)).toBeNull();
    expect(holdEntries()).toBe(2);
  });
});
