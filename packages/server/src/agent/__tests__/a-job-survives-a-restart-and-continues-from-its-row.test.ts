// A parked job lives on its task row, so a restart loses nothing: the job is still owed at boot. A Dojo that dies
// during a job's stretch leaves its request claimed by a dead turn: the boot's crash arm hands it back, and it is
// served as a person with its task in view.
import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../../db/connection.js', async () => (await import('./helpers/agent-requests.js')).connectionMock());
vi.mock('../../gateway/ws.js', () => ({ broadcast: () => {}, stampPersistedRow: (e: unknown) => e }));
vi.mock('../runtime.js', () => ({ getAgentRuntime: () => ({ handleMessage: async () => 'ran' }) }));

import { runMigrations } from '../../db/migrations.js';
import { nextOwed } from '../v2/owed.js';
import { reconcileOrphanedClaims } from '../../work/orphaned-claims.js';
import { freshAgentsDb, HELPER } from './helpers/agent-requests.js';
import { ownerAsks, stretch, rowOf, tasksOf } from './helpers/long-job.js';

beforeEach(() => { freshAgentsDb(runMigrations); });

describe('a job survives a restart and continues from its row', () => {
  it('parked, then the Dojo restarts: the job is owed and its next stretch runs from the row', async () => {
    await ownerAsks('m-1');
    await stretch('parks');
    const [task] = tasksOf('m-1');
    expect(nextOwed(HELPER).map((i) => [i.kind, i.ref])).toEqual([['job', task]]);
    expect(await stretch('parks')).toMatchObject({ root: 'm-1', servedJob: task });
  });

  it('the Dojo dies during a stretch: at boot the request is handed back and served as a person', async () => {
    const ask = await ownerAsks('m-1');
    await stretch('parks');
    const [task] = tasksOf('m-1');
    await stretch('crash');
    expect(rowOf(ask).state, 'claimed by the dead turn').toBe('claimed');
    expect(rowOf(task).due, 'the pickup took the due').toBeNull();
    reconcileOrphanedClaims({ agentId: HELPER });
    expect(rowOf(ask).state).toBe('open');
    expect(nextOwed(HELPER)[0]).toMatchObject({ kind: 'person', ref: ask });
  });
});
