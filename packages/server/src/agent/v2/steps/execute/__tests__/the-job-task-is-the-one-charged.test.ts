// t362 — MEASURED JOB ITEMS ARE CHARGED TO THE WRONG CLAIMED TASK.
//
// Two places pick "the agent's task" and they disagreed. The charge site
// (`tracker-counting.ts`'s `countTrackerWorkThisIteration`) charged to
// `resolveCurrentClaimedTaskId` — the most recently updated claimed task — while the turn end
// reads the job through `job-turn-end.ts`'s `jobTaskOf`, which on a job's own turn restricts to the
// task the turn was started from. An agent that opened a small second task for an
// owner message during the continued turn (so it is the more recently updated one) had every
// labelled item charged to that second task; `ledgerNewItemsSince` / `novelCallsInTurn` on the
// job's own task then read 0, momentum was false, and `continueTheJob` recorded `stalled` for
// a job that did all its work. `taskToCharge` makes the charge site ask the same question the
// turn end asks.
//
// Setup copied from effort-accumulates-until-the-task-advances.test.ts: the mocked `getDb` over
// an in-memory db built by the shared work fixture; the turn's bag says which task the turn was
// started from, per case below.
import { describe, it, expect, beforeEach, vi } from 'vitest';
import Database from 'better-sqlite3';

const mockDb = { current: null as Database.Database | null };
vi.mock('../../../../../db/connection.js', () => ({
  getDb: () => {
    if (!mockDb.current) throw new Error('test DB not initialized');
    return mockDb.current;
  },
}));

import { taskToCharge } from '../tracker-counting.js';
import { openTurnContext } from '../../../../turn-context.js';
import { createWorkTable, seedTrackerTask } from '../../../../../work/__tests__/work-fixture.js';

beforeEach(() => {
  mockDb.current = new Database(':memory:');
  createWorkTable(mockDb.current);
  // The job's task, and a second claimed task opened DURING the continued turn — the one
  // the old pick charged everything to.
  seedTrackerTask(mockDb.current, { id: 'job-task', agentId: 'agent-j', status: 'in_progress', updated_at: 1_700_000_000_000 });
  seedTrackerTask(mockDb.current, { id: 'newer-task', agentId: 'agent-j', status: 'in_progress', updated_at: 1_700_000_900_000 });
  openTurnContext('agent-j').servedJob = 'job-task';
});

describe('t362 taskToCharge — the job the turn end will read is the job the items are charged to', () => {
  it('a job\'s own turn: the task it was started from pays, not the more recently updated second claim', () => {
    // The turn end (`jobTaskOf`) will read `job-task`; the ledger and the novelty must be
    // written to the SAME row, or the job is recorded `stalled` for work it really did.
    expect(taskToCharge('agent-j')).toBe('job-task');
  });

  it('a turn that is not the job\'s keeps the old pick: the most recently updated claimed task', () => {
    openTurnContext('agent-j').servedJob = null;
    expect(taskToCharge('agent-j')).toBe('newer-task');
  });

  it('the job\'s task is no longer working: `jobTaskOf` gives null, so the old pick stands', () => {
    openTurnContext('agent-j').servedJob = 'ended-task';
    expect(taskToCharge('agent-j')).toBe('newer-task');
  });
});
