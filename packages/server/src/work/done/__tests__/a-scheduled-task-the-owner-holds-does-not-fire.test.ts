// A recurring task the owner put on hold does not fire and wakes nobody while held; once the owner
// resumes it from the dashboard, the scheduler's due scan fires it again.
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../../db/connection.js', async () => (await import('./helpers/done-db.js')).connectionMock());
vi.mock('../../../gateway/ws.js', () => ({ broadcast: () => {}, stampPersistedRow: (e: unknown) => e }));
const woken = vi.hoisted(() => [] as string[]);
vi.mock('../../../agent/runtime.js', () => ({
  getAgentRuntime: () => ({ handleMessage: async (id: string) => { woken.push(id); return 'ran'; }, whenQueuedRunEnds: async () => 'ran' }),
}));
vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 });

import { trackerRouter } from '../../../gateway/routes/tracker.js';
import { checkScheduledTasks } from '../../../scheduler/runner.js';
import { doneDb } from './helpers/done-db.js';
import { freshBoard, TASK, WORKER } from './helpers/decision-world.js';

const put = (status: string) => trackerRouter.request(`/tasks/${TASK}`, {
  method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ status }),
});
const runs = (): number => (doneDb().prepare("SELECT COUNT(*) AS n FROM work WHERE kind = 'occurrence' AND parent_id = ?").get(TASK) as { n: number }).n;
const toWorker = (): number => (doneDb().prepare('SELECT COUNT(*) AS n FROM messages WHERE agent_id = ?').get(WORKER) as { n: number }).n;

beforeEach(async () => {
  freshBoard();
  doneDb().prepare(
    "UPDATE work SET repeat_interval = 1, repeat_unit = 'hours', schedule_status = 'waiting', is_paused = 0, next_run_at = ?, scheduled_start = ? WHERE id = ?",
  ).run(Date.now() - 5_000, Date.now() - 5_000, TASK);
  woken.length = 0;
  expect((await put('paused')).status).toBe(200);
});

describe('a scheduled task the owner holds does not fire', () => {
  it('stays unfired and wakes nobody while held, and fires again once the owner resumes it', async () => {
    const before = toWorker();
    await checkScheduledTasks();
    expect(runs()).toBe(0);
    expect(woken).toEqual([]);
    expect(toWorker()).toBe(before);

    expect((await put('on_deck')).status).toBe(200);
    await checkScheduledTasks();
    expect(runs()).toBe(1);
    await vi.waitFor(() => expect(woken).toContain(WORKER));
  });
});
