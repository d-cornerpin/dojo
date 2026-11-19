// A job's own turn whose first model call meets a provider limit spent nothing: its task waits for the reset and
// the job resumes then; its request stays held on the job and is never counted or reopened.
import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../../db/connection.js', async () => (await import('./helpers/agent-requests.js')).connectionMock());
vi.mock('../../gateway/ws.js', () => ({ broadcast: () => {}, stampPersistedRow: (e: unknown) => e }));
vi.mock('../runtime.js', () => ({ getAgentRuntime: () => ({ handleMessage: async () => 'ran' }) }));

import { runMigrations } from '../../db/migrations.js';
import { nextOwed } from '../v2/owed.js';
import { freshAgentsDb, askerDelegates, HELPER } from './helpers/agent-requests.js';
import { ownerAsks, stretch, rowOf, tasksOf } from './helpers/long-job.js';

beforeEach(() => { freshAgentsDb(runMigrations); });

describe('a rate-limited job resumes at the reset', () => {
  it('another agent\'s job (no person behind it): the task is due at the reset', async () => {
    await askerDelegates('QUESTION', 'thread-limited-job-0001');
    await stretch('parks');
    const reset = Date.now() + 5 * 60_000;
    const seen = await stretch({ limitUntil: reset });
    expect(seen?.kind).toBe('a2a');
    expect(rowOf(seen!.servedJob!).due).toBe(reset);
    expect(nextOwed(HELPER)).toEqual([]);
    expect(nextOwed(HELPER, reset).map((i) => i.kind)).toEqual(['job']);
  });

  it('the owner\'s job: the task waits for the reset and his request stays held', async () => {
    const ask = await ownerAsks('m-1');
    await stretch('parks');
    const reset = Date.now() + 5 * 60_000;
    await stretch({ limitUntil: reset });
    const [task] = tasksOf('m-1');
    expect(rowOf(task).due).toBe(reset);
    expect(rowOf(ask)).toMatchObject({ state: 'blocked', due: null });
  });
});
