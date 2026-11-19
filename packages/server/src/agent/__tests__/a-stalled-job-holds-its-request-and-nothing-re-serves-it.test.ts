// A job stretch that moved nothing ends without parking: its request stays held on the task, the task has no due
// time, and nothing is owed, so no further paid turn runs until the task moves, ends or the person writes.
import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../../db/connection.js', async () => (await import('./helpers/agent-requests.js')).connectionMock());
vi.mock('../../gateway/ws.js', () => ({ broadcast: () => {}, stampPersistedRow: (e: unknown) => e }));
vi.mock('../runtime.js', () => ({ getAgentRuntime: () => ({ handleMessage: async () => 'ran' }) }));

import { runMigrations } from '../../db/migrations.js';
import { nextOwed, dueOf } from '../v2/owed.js';
import { freshAgentsDb, HELPER } from './helpers/agent-requests.js';
import { ownerAsks, stretch, rowOf, tasksOf } from './helpers/long-job.js';

beforeEach(() => { freshAgentsDb(runMigrations); });

describe('a stalled job holds its request and nothing re-serves it', () => {
  it('one stalled stretch, then nothing is owed and the clock wakes nothing', async () => {
    const ask = await ownerAsks('m-1');
    await stretch('parks');
    const [task] = tasksOf('m-1');
    expect((await stretch('stalls'))?.servedJob).toBe(task);
    expect(rowOf(ask).state).toBe('blocked');
    expect(rowOf(task)).toMatchObject({ state: 'claimed', due: null });
    expect(nextOwed(HELPER)).toEqual([]);
    expect(dueOf(HELPER), 'the clock has nothing to wake it for').toEqual({ now: false, next: null });
  });

  it('the owner writing again is served first, with the job still held', async () => {
    const ask = await ownerAsks('m-1');
    await stretch('parks');
    await stretch('stalls');
    await ownerAsks('m-2', 'how is it going?');
    expect(nextOwed(HELPER)[0]).toMatchObject({ kind: 'person', rank: 1 });
    expect(rowOf(ask).state).toBe('blocked');
  });
});
