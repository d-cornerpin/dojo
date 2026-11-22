// A repeating task's run is in flight when its cadence is changed, on the board (the lived door) or by the agent's
// own edit. The run stays running: the next tick claims nothing, the orphan sweep leaves the run open, and after
// the run closes the next run is at the new cadence.
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';

vi.mock('../../gateway/ws.js', () => ({ broadcast: () => {}, stampPersistedRow: (e: unknown) => e }));
vi.mock('../../agent/v2/loop.js', () => ({ runV2Turn: async () => {} }));
const box = await import('./helpers/reminders-box.js');
const { at, call, db, checkScheduledTasks } = box;
const { trackerRouter } = await import('../../gateway/routes/tracker.js');
const { sweepOrphanedOccurrences } = await import('../../work/occurrences.js');
const { onTaskRunComplete } = await import('../runner.js');

beforeAll(() => box.openBox());
afterAll(() => box.closeBox());

const row = (id: string) => db().prepare('SELECT schedule_status AS status, next_run_at AS next FROM work WHERE id = ?').get(id) as { status: string; next: number };
const runs = (id: string): Array<{ state: string }> => db().prepare("SELECT state FROM work WHERE kind = 'occurrence' AND parent_id = ? ORDER BY sequence").all(id) as Array<{ state: string }>;

const doors = {
  board: async (id: string, start: string) => {
    const res = await trackerRouter.request(`/tasks/${id}`, { method: 'PUT', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ scheduled_start: start, repeat_interval: 6, repeat_unit: 'minutes' }) });
    expect(res.status).toBe(200);
  },
  agent: async (id: string) => {
    const r = await call('work_update', { action: 'edit', task_id: id, repeat_interval: 6 });
    expect(r.isError, r.content).toBeFalsy();
  },
};

describe('a schedule edited during its run claims nothing twice', () => {
  for (const [door, edit] of Object.entries(doors)) {
    it(`edited by ${door === 'board' ? 'the owner on the board' : 'the agent'} while its first run is in flight`, async () => {
      const day = door === 'board' ? '2026-03-02' : '2026-03-03';
      const start = `${day}T07:45:00.000Z`;
      at(`${day}T07:40:00Z`);
      const made = await call('work_open', { kind: 'task', title: `Inbox count ${door}`, goal: 'count what is left in the inbox',
        scheduled_start: start, repeat_interval: 5, repeat_unit: 'minutes', allow_duplicate: true });
      const id = /task_id=([\w-]+)/.exec(made.content)![1]!;
      at(`${day}T07:45:25Z`);
      await checkScheduledTasks();
      expect(runs(id)).toEqual([{ state: 'open' }]);

      at(`${day}T07:45:27Z`);
      await edit(id, start);
      expect(row(id).status, 'the run in flight keeps the schedule running').toBe('running');
      at(`${day}T07:45:55Z`);
      await checkScheduledTasks();
      expect(runs(id), 'the next tick claims nothing').toEqual([{ state: 'open' }]);
      expect(sweepOrphanedOccurrences(Date.parse(`${day}T07:51:30Z`)), 'the orphan sweep leaves the live run open').toBe(0);

      expect(await onTaskRunComplete(id, 'complete', 'counted')).toBe(true);
      expect(row(id).next, 'the next run is at the new cadence').toBe(Date.parse(`${day}T07:51:00Z`));
    });
  }
});
