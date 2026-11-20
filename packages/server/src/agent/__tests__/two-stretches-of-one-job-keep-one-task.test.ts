// A long job's stretches all run on one task row: the first park opens the engine task linked to the request, and
// every later stretch is served from that row, rooted in the same request, and parks on the same task.
import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../../db/connection.js', async () => (await import('./helpers/agent-requests.js')).connectionMock());
vi.mock('../../gateway/ws.js', () => ({ broadcast: () => {}, stampPersistedRow: (e: unknown) => e }));
vi.mock('../runtime.js', () => ({ getAgentRuntime: () => ({ handleMessage: async () => 'ran' }) }));

import { runMigrations } from '../../db/migrations.js';
import { nextOwed } from '../v2/owed.js';
import { PARKED_JOB_TITLE } from '../../work/tracker-view.js';
import { freshAgentsDb, testDb, HELPER } from './helpers/agent-requests.js';
import { ownerAsks, stretch, rowOf, tasksOf } from './helpers/long-job.js';

beforeEach(() => { freshAgentsDb(runMigrations); });

describe('two stretches of one job keep one task', () => {
  it('the park opens one task for the request; the next stretch is served from it and parks on it again', async () => {
    const ask = await ownerAsks('m-1');
    const first = await stretch('parks');
    const [task] = tasksOf('m-1');
    expect(first?.parkedOn).toBe(task);
    expect((testDb().prepare('SELECT title FROM work WHERE id = ?').get(task) as { title: string }).title).toBe(PARKED_JOB_TITLE);
    expect(rowOf(ask).state).toBe('blocked');
    expect(nextOwed(HELPER).map((i) => [i.kind, i.ref, i.rank])).toEqual([['job', task, 3]]);

    const second = await stretch('parks');
    expect(second).toEqual({ root: 'm-1', kind: 'ask', servedJob: task, parkedOn: task });
    expect(tasksOf('m-1')).toEqual([task]);
    expect(rowOf(ask).state).toBe('blocked');
    expect(rowOf(task).due).not.toBeNull();
  });
});
