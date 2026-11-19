// The owner's Stop ends the request being served for good: it is called off, its parked job is held with no due,
// and nothing serves it again, not after the turn ends and not after a restart.
import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../../db/connection.js', async () => (await import('./helpers/agent-requests.js')).connectionMock());
vi.mock('../../gateway/ws.js', () => ({ broadcast: () => {}, stampPersistedRow: (e: unknown) => e }));
vi.mock('../v2/loop.js', () => ({ runV2Turn: async () => {} }));

import { runMigrations } from '../../db/migrations.js';
import { stopByOwner } from '../runtime.js';
import { nextOwed, dueOf } from '../v2/owed.js';
import { stoppedAgents } from '../shared-state.js';
import { reconcileOrphanedClaims } from '../../work/orphaned-claims.js';
import { healStuckClaims } from '../../work/ask-remediation.js';
import { freshAgentsDb, HELPER } from './helpers/agent-requests.js';
import { ownerAsks, stretch, rowOf, tasksOf } from './helpers/long-job.js';

// A run's start clears the Stop flag; these turns start without the runtime, so each test starts clear.
beforeEach(() => { freshAgentsDb(runMigrations); stoppedAgents.clear(); });

const nothingComesBack = (): void => {
  expect(nextOwed(HELPER)).toEqual([]);
  expect(dueOf(HELPER).now).toBe(false);
};

describe('stop ends the request and nothing serves it again', () => {
  it('Stop during the turn: the request is called off, and after a restart nothing finds it', async () => {
    const ask = await ownerAsks('m-1');
    await stretch('stopped', () => expect(stopByOwner(HELPER)).toMatchObject({ ended: 1 }));
    expect(rowOf(ask).state).toBe('abandoned');
    nothingComesBack();
    reconcileOrphanedClaims({ agentId: HELPER });
    healStuckClaims();
    expect(rowOf(ask).state).toBe('abandoned');
    nothingComesBack();
  });

  it('Stop on a job turn: its task loses its due and is held, so the job never comes back by itself', async () => {
    const ask = await ownerAsks('m-1');
    await stretch('parks');
    const [task] = tasksOf('m-1');
    await stretch('stopped', () => stopByOwner(HELPER));
    expect(rowOf(ask).state).toBe('abandoned');
    expect(rowOf(task)).toMatchObject({ due: null, hold: 'paused' });
    nothingComesBack();
  });

  it('Stop while the job is parked and the agent is idle ends the job with its request', async () => {
    const ask = await ownerAsks('m-1');
    await stretch('parks');
    const [task] = tasksOf('m-1');
    expect(stopByOwner(HELPER)).toMatchObject({ ended: 1 });
    expect(rowOf(ask).state).toBe('abandoned');
    expect(rowOf(task)).toMatchObject({ due: null, hold: 'paused' });
    nothingComesBack();
  });
});
