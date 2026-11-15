// A task the owner paused stays paused until the owner resumes it (or the main agent on his quoted ask): the PM's retask, the worker's status change and the
// worker's own hold are refused with one plain sentence; the owner resumes it from the dashboard.
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../../db/connection.js', async () => (await import('./helpers/done-db.js')).connectionMock());
vi.mock('../../../gateway/ws.js', () => ({ broadcast: () => {}, stampPersistedRow: (e: unknown) => e }));
vi.mock('../../../agent/runtime.js', async () => (await import('./helpers/ladder-world.js')).runtimeMock());
vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 });

import { trackerRouter } from '../../../gateway/routes/tracker.js';
import { holdOf } from '../hold.js';
import { freshBoard, call, PM, WORKER, TASK } from './helpers/decision-world.js';

const REFUSED = /^Refused: The owner put this task on hold\. Only the owner, or the main agent when the owner asks, can release it\. /;
const put = (body: Record<string, unknown>) => trackerRouter.request(`/tasks/${TASK}`, {
  method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
});

beforeEach(async () => {
  freshBoard();
  expect((await put({ status: 'paused' })).status).toBe(200);
  expect(holdOf(TASK)?.kind).toBe('paused');
});

describe('an owner\'s pause is lifted only by the owner', () => {
  it('the PM\'s retask is refused and the pause stands', async () => {
    const r = await call(PM, 'work_validate', { action: 'retask', task_id: TASK, directive: 'Go on with the report; the owner has everything he needs from you now.' });
    expect(r.content).toMatch(REFUSED);
    expect(holdOf(TASK)?.kind).toBe('paused');
  });

  it('the worker cannot resume it, move it, or replace the owner\'s pause with its own', async () => {
    for (const args of [{ status: 'in_progress' }, { status: 'on_deck' }, { status: 'paused', notes: 'waiting for the vendor to send the price list' }]) {
      const r = await call(WORKER, 'work_update', { action: 'status', task_id: TASK, ...args });
      expect(r.content, JSON.stringify(args)).toMatch(REFUSED);
    }
    expect(holdOf(TASK)).toMatchObject({ kind: 'paused', reason: 'paused by the owner on the dashboard' });
  });

  it('the owner resumes it from the dashboard', async () => {
    expect((await put({ status: 'in_progress' })).status).toBe(200);
    expect(holdOf(TASK)).toBeNull();
  });
});
