// The park opens a task for a request that had none, and the agent never hears of it. When the job's final report
// closes the request, that task closes done with it, so it does not sit Working for the ladder to nudge or wait for a review.
import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../../db/connection.js', async () => (await import('./helpers/agent-requests.js')).connectionMock());
vi.mock('../../gateway/ws.js', () => ({ broadcast: () => {}, stampPersistedRow: (e: unknown) => e }));
vi.mock('../runtime.js', () => ({ getAgentRuntime: () => ({ handleMessage: async () => 'ran' }) }));

import { runMigrations } from '../../db/migrations.js';
import { PARKED_JOB_TITLE } from '../../work/tracker-view.js';
import { freshAgentsDb, testDb } from './helpers/agent-requests.js';
import { ownerAsks, stretch, rowOf, tasksOf } from './helpers/long-job.js';

beforeEach(() => { freshAgentsDb(runMigrations); });

describe('a finished job closes the task the engine opened', () => {
  it('after the final report the request is done and its park-opened task is done on the same delivery', async () => {
    const ask = await ownerAsks('m-1');
    await stretch('parks');
    const [task] = tasksOf('m-1');
    expect((testDb().prepare('SELECT title FROM work WHERE id = ?').get(task) as { title: string }).title).toBe(PARKED_JOB_TITLE);
    await stretch('answers');
    expect(rowOf(ask).state).toBe('done');
    expect(rowOf(task).state).toBe('done');
    const closedOn = (id: string) => (testDb().prepare('SELECT result_delivery_id AS d FROM work WHERE id = ?').get(id) as { d: string }).d;
    expect(closedOn(task)).toBe(closedOn(ask));
    expect(rowOf(task).due).toBeNull();
  });
});
