// A helper that is working is never moved up the ladder and its request is never ended, however long it takes: in a
// run, with its reminder still coming, or waiting on a live helper of its own. A parked job for other work does not
// count: the dropped task is still reminded.
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../../db/connection.js', async () => (await import('./helpers/done-db.js')).connectionMock());
vi.mock('../../../gateway/ws.js', async () => (await import('./helpers/ladder-world.js')).wsMock());
vi.mock('../../../agent/runtime.js', async () => (await import('./helpers/ladder-world.js')).runtimeMock());
vi.mock('../../../tracker/pm-agent.js', async (orig) => ({ ...(await orig<object>()), armDebouncedReview: vi.fn() }));
vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 });

import { runLadder, LADDER_ENTRY } from '../ladder.js';
import { activeRuns } from '../../../agent/shared-state.js';
import { openDelegationJoin } from '../../store.js';
import { freshBoard, PM, MAIN, WORKER, OTHER, TASK } from './helpers/decision-world.js';
import { cards, entries, hintsTo, keptRequest, keptState, pmCanRun, resetLadderWorld, workingTask, anchorBack, MIN } from './helpers/ladder-world.js';
import { doneDb } from './helpers/done-db.js';

/** Many sweeps, out to four days on the ladder's clock (the owed windows read the real one): nothing climbs past what `hints` allows, nothing is carded, the request is kept. */
async function longWait(ask: string, hints: number): Promise<void> {
  for (const at of [6, 12, 30, 120, 1440, 5760]) await runLadder(Date.now() + at * MIN);
  expect([hintsTo(WORKER).length, entries(TASK, LADDER_ENTRY.pm), cards.length, ...(await keptState(ask))]).toEqual([hints, 0, 0, 'claimed', 'open']);
}

let ask = '';
beforeEach(async () => { freshBoard(); pmCanRun(PM); anchorBack(2 * 60 * MIN); resetLadderWorld(); ask = await keptRequest(WORKER, TASK, MAIN); });

describe('a busy helper is never carded', () => {
  it('in a run', async () => {
    activeRuns.add(WORKER);
    try { await longWait(ask, 0); } finally { activeRuns.delete(WORKER); }
  });

  it('with its reminder still coming, five hours after it was sent', async () => {
    await runLadder(Date.now() + 6 * MIN);
    doneDb().prepare("UPDATE messages SET created_at = created_at - ? WHERE agent_id = ? AND lane = 'events'").run(5 * 60 * MIN, WORKER);
    await longWait(ask, 1);
  });

  it('waiting on a live helper of its own', async () => {
    workingTask('task-sub', OTHER, 'Count the pages');
    doneDb().prepare("UPDATE work SET a2a_thread_id = 'thread-sub' WHERE id = 'task-sub'").run();
    openDelegationJoin({ parentWorkId: TASK, agentId: WORKER, replyConversationId: null, ttlAt: Date.now() + 3_600_000,
      threads: [{ threadId: 'thread-sub', assigneeAgent: OTHER, intent: 'ASSIGN', hopCount: 0 }] });
    await longWait(ask, 0);
  });

  it('a parked job for other work does not keep the dropped task from its reminder', async () => {
    workingTask('task-parked', WORKER, 'Render the video');
    doneDb().prepare("UPDATE work SET next_attempt_at = ? WHERE id = 'task-parked'").run(Date.now() + 3 * 24 * 60 * MIN);
    await runLadder(Date.now() + 6 * MIN);
    expect(hintsTo(WORKER).filter((h) => h.includes(TASK))).toHaveLength(1);
  });
});
