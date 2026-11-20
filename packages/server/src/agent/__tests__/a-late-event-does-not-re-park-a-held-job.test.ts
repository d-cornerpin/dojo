// A park that waits for an event (a writer coming back, a lock freed) has a backstop due time; when the event
// comes it moves the job to now only while the job is still parked, not held and still working.
import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../../db/connection.js', async () => (await import('./helpers/agent-requests.js')).connectionMock());
vi.mock('../../gateway/ws.js', () => ({ broadcast: () => {}, stampPersistedRow: (e: unknown) => e }));
vi.mock('../runtime.js', () => ({ getAgentRuntime: () => ({ handleMessage: async () => 'ran' }) }));

import { runMigrations } from '../../db/migrations.js';
import { parkJob } from '../../work/job-continuation.js';
import { setHold } from '../../work/done/hold.js';
import { openTurnContext, endTurnContext } from '../turn-context.js';
import { freshAgentsDb, testDb, HELPER } from './helpers/agent-requests.js';
import { ownerAsks, rowOf } from './helpers/long-job.js';

beforeEach(async () => { freshAgentsDb(runMigrations); await ownerAsks('m-1'); });

/** A turn serving the owner's request parks on an event; returns the task and the event's trigger. */
function parkOnAnEvent(): { task: string; arrive: () => Promise<void> } {
  let fire!: () => void;
  const event = new Promise<void>((r) => { fire = r; });
  const bag = openTurnContext(HELPER);
  bag.turnNumber = 1;
  bag.root = { kind: 'ask', id: 'm-1', sourceMessageId: 'm-1' };
  expect(parkJob(HELPER, 'waits for the writer', 'event', event)).toBe(true);
  const task = bag.jobParked!;
  endTurnContext(HELPER);
  return { task, arrive: async () => { fire(); await event; await Promise.resolve(); } };
}

describe('a late event does not re-park a held job', () => {
  it('the event moves a parked job to now', async () => {
    const { task, arrive } = parkOnAnEvent();
    expect(rowOf(task).due).toBeGreaterThan(Date.now() + 10 * 60_000);   // the backstop
    await arrive();
    expect(rowOf(task).due).toBeLessThanOrEqual(Date.now());
  });

  it('a job the owner held, or a job turn already picked up, is not moved', async () => {
    const held = parkOnAnEvent();
    const backstop = rowOf(held.task).due;
    expect(setHold(held.task, 'paused', 'wait', 'owner')).toEqual({ ok: true });
    await held.arrive();
    expect(rowOf(held.task).due).toBe(backstop);

    const picked = parkOnAnEvent();
    testDb().prepare('UPDATE work SET next_attempt_at = NULL WHERE id = ?').run(picked.task);
    await picked.arrive();
    expect(rowOf(picked.task).due).toBeNull();
  });
});
