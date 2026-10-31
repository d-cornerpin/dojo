// t362 — MEASURED JOB ITEMS ARE CHARGED TO THE WRONG CLAIMED TASK.
//
// Two places pick "the agent's task" and they disagreed. The charge site
// (`tracker-counting.ts`'s `countTrackerWorkThisIteration`) charged to
// `resolveCurrentClaimedTaskId` — the most recently updated claimed task — while the turn end
// reads the job through `job-turn-end.ts`'s `jobTaskOf`, which on a run the park's own wake
// started restricts to the job's carried ids. An agent that opened a small second task for an
// owner message during the continued turn (so it is the more recently updated one) had every
// labelled item charged to that second task; `ledgerNewItemsSince` / `novelCallsInTurn` on the
// job's own task then read 0, momentum was false, and `continueTheJob` recorded `stalled` for
// a job that did all its work. `taskToCharge` makes the charge site ask the same question the
// turn end asks.
//
// Setup copied from effort-accumulates-until-the-task-advances.test.ts: the mocked `getDb` over
// an in-memory db built by the shared work fixture. `task-freshness` is mocked so the answers
// "is this the run the park started?" and "which ids does the job carry?" are per case below.
import { describe, it, expect, beforeEach, vi } from 'vitest';
import Database from 'better-sqlite3';

const mockDb = { current: null as Database.Database | null };
vi.mock('../../../../../db/connection.js', () => ({
  getDb: () => {
    if (!mockDb.current) throw new Error('test DB not initialized');
    return mockDb.current;
  },
}));

// The two answers `jobTaskOf` asks the job registry; flipped per case. The mock's closures
// read this holder at CALL time (inside the tests), never at module-load time.
const job = { carries: true, carried: ['job-task'] as string[] };
vi.mock('../../../../../work/task-freshness.js', () => ({
  runCarriesJob: () => job.carries,
  jobCarriedIds: () => job.carried,
}));

import { taskToCharge } from '../tracker-counting.js';
import { createWorkTable, seedTrackerTask } from '../../../../../work/__tests__/work-fixture.js';

beforeEach(() => {
  mockDb.current = new Database(':memory:');
  createWorkTable(mockDb.current);
  // The job's task, and a second claimed task opened DURING the continued turn — the one
  // the old pick charged everything to.
  seedTrackerTask(mockDb.current, { id: 'job-task', agentId: 'agent-j', status: 'in_progress', updated_at: 1_700_000_000_000 });
  seedTrackerTask(mockDb.current, { id: 'newer-task', agentId: 'agent-j', status: 'in_progress', updated_at: 1_700_000_900_000 });
  job.carries = true;
  job.carried = ['job-task'];
});

describe('t362 taskToCharge — the job the turn end will read is the job the items are charged to', () => {
  it('the run the park\'s own wake started: the job\'s carried task pays, not the more recently updated second claim', () => {
    // The turn end (`jobTaskOf`) will read `job-task`; the ledger and the novelty must be
    // written to the SAME row, or the job is recorded `stalled` for work it really did.
    expect(taskToCharge('agent-j')).toBe('job-task');
  });

  it('a run that is not the continuation keeps the old pick: the most recently updated claimed task', () => {
    job.carries = false;
    expect(taskToCharge('agent-j')).toBe('newer-task');
  });

  it('the job carries no open task: `jobTaskOf` gives null, so the old pick stands', () => {
    job.carried = [];
    expect(taskToCharge('agent-j')).toBe('newer-task');
  });
});
