// A schedule is paused while one of its runs is open; the reaper's orphan sweep closes that run once its grace has
// passed. The run count advances with it, so when the schedule is resumed its next run starts.
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';

vi.mock('../../gateway/ws.js', () => ({ broadcast: () => {}, stampPersistedRow: (e: unknown) => e }));
vi.mock('../../agent/v2/loop.js', () => ({ runV2Turn: async () => {} }));
const box = await import('./helpers/missed-runs-box.js');
const { cleanupStaleRuns } = await import('../runner.js');

beforeAll(() => box.openBox());
afterAll(() => box.closeBox());

const runs = (id: string) => box.db().prepare("SELECT sequence, state FROM work WHERE kind = 'occurrence' AND parent_id = ? ORDER BY sequence").all(id) as Array<{ sequence: number; state: string }>;

describe('a schedule paused mid-run starts again when resumed', () => {
  it('the swept run is closed, and the resumed schedule fires run 2', async () => {
    box.at('2026-03-02T12:00:00Z');
    const made = await box.call('work_open', { kind: 'task', title: 'Tidy the downloads', goal: 'the folder is tidy', scheduled_start: '2026-03-02T12:05:00Z', repeat_interval: 10, repeat_unit: 'minutes' });
    const task = /task_id=([\w-]+)/.exec(made.content)![1]!;
    box.at('2026-03-02T12:05:30Z');
    await box.checkScheduledTasks();
    expect((await box.call('work_schedule', { action: 'pause', task_id: task })).isError).toBeFalsy();
    box.at('2026-03-02T12:12:00Z');
    cleanupStaleRuns();
    expect(runs(task)).toMatchObject([{ sequence: 1, state: 'abandoned' }]);
    expect((await box.call('work_schedule', { action: 'resume', task_id: task })).isError).toBeFalsy();
    box.at('2026-03-02T12:15:30Z');
    await box.checkScheduledTasks();
    expect(runs(task).map((r) => r.sequence)).toEqual([1, 2]);
  });
});
