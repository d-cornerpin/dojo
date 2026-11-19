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
import { freshAgentsDb, testDb, HELPER } from './helpers/agent-requests.js';
import { seedTrackerTask } from '../../work/__tests__/work-fixture.js';
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

  it('Stop after the owner asked how the parked job is going ends that job, and after a restart nothing wakes it', async () => {
    const ask = await ownerAsks('m-1');
    await stretch('parks');
    const [task] = tasksOf('m-1');
    await ownerAsks('m-2', 'How is it going?');
    expect(await stretch('answers')).toMatchObject({ root: 'm-2' });
    const stopped = stopByOwner(HELPER);
    expect(stopped.nothingRunning).toBeUndefined();
    expect(stopped.ended).toBe(1);
    expect(rowOf(ask).state).toBe('abandoned');
    const by = testDb().prepare("SELECT json_extract(payload, '$.by') AS by FROM work_events WHERE work_id = ? AND kind = 'transition' ORDER BY id DESC LIMIT 1").get(ask);
    expect(by).toEqual({ by: 'owner' });
    expect(rowOf(task)).toMatchObject({ due: null, hold: 'paused' });
    nothingComesBack();
    reconcileOrphanedClaims({ agentId: HELPER });
    healStuckClaims();
    nothingComesBack();
  });

  it("Stop with the agent's own task parked and no request behind it ends that job", () => {
    seedTrackerTask(testDb(), { id: 'own-task', agentId: HELPER, title: 'Tidy the archive', next_attempt_at: Date.now() - 1_000 });
    expect(nextOwed(HELPER).map((i) => i.kind)).toEqual(['job']);
    expect(stopByOwner(HELPER).nothingRunning).toBeUndefined();
    expect(rowOf('own-task')).toMatchObject({ due: null, hold: 'paused' });
    nothingComesBack();
  });
});
