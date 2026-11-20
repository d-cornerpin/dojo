// The owner asks how his long job is going while it runs: his question is served at the job's next step (it
// outranks the job), answered and closed on its own delivery, and the job's own turn then goes on from its row.
import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../../db/connection.js', async () => (await import('./helpers/agent-requests.js')).connectionMock());
vi.mock('../../gateway/ws.js', () => ({ broadcast: () => {}, stampPersistedRow: (e: unknown) => e }));
vi.mock('../runtime.js', () => ({ getAgentRuntime: () => ({ handleMessage: async () => 'ran' }) }));

import { runMigrations } from '../../db/migrations.js';
import { nextOwed } from '../v2/owed.js';
import { freshAgentsDb, HELPER } from './helpers/agent-requests.js';
import { ownerAsks, stretch, rowOf, tasksOf } from './helpers/long-job.js';

beforeEach(() => { freshAgentsDb(runMigrations); });

describe('how is it going gets an answer and the job goes on', () => {
  it('the status question is served first and closed; the next turn is the job\'s own', async () => {
    const job = await ownerAsks('m-1');
    await stretch('parks');
    const [task] = tasksOf('m-1');
    const status = await ownerAsks('m-2', 'how is it going?');
    expect(nextOwed(HELPER).map((i) => [i.kind, i.rank])).toEqual([['person', 1], ['job', 3]]);
    expect((await stretch('answers'))?.root).toBe('m-2');
    expect(rowOf(status).state).toBe('done');
    expect(rowOf(job).state, 'the job\'s request stays held on its job').toBe('blocked');
    expect(await stretch('parks')).toMatchObject({ root: 'm-1', servedJob: task, parkedOn: task });
  });
});
