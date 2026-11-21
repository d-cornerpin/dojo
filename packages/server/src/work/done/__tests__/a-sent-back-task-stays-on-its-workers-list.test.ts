// A sent-back task is still Working: it stays on its worker's assembled task list and in work_update's list,
// and when it does not move its worker gets the stall hint.
import { describe, it, expect, vi } from 'vitest';

vi.mock('../../../db/connection.js', async () => (await import('./helpers/done-db.js')).connectionMock());
vi.mock('../../../gateway/ws.js', async () => (await import('./helpers/ladder-world.js')).wsMock());
vi.mock('../../../agent/runtime.js', async () => (await import('./helpers/ladder-world.js')).runtimeMock());
vi.mock('../../../tracker/pm-agent.js', async (orig) => ({ ...(await orig<object>()), armDebouncedReview: vi.fn() }));
vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 });

import { runLadder } from '../ladder.js';
import { buildWorkBoardLane } from '../../../memory/work-board-lane.js';
import { freshBoard, handedIn, call, stateOf, PM, WORKER, TASK } from './helpers/decision-world.js';
import { hintsTo, resetLadderWorld, turnTaken, MIN } from './helpers/ladder-world.js';

describe('a sent-back task stays on its worker\'s list', () => {
  it('is on the assembled list and in work_update\'s list, and its stall is hinted', async () => {
    freshBoard(); resetLadderWorld();
    await handedIn();
    expect((await call(PM, 'work_validate', { action: 'decide', task_id: TASK, verdict: 'send_back', reason: 'The totals page is missing' })).isError).toBe(false);
    expect(stateOf()).toBe('sent_back');
    expect((await buildWorkBoardLane(WORKER)).activeTasks).toContain('Write the report');
    expect((await call(WORKER, 'work_update', { action: 'list' })).content).toContain('Write the report');
    turnTaken(WORKER);   // its turn took the send-back and ended
    await runLadder(Date.now() + 6 * MIN);
    expect(hintsTo(WORKER).filter((h) => h.includes('has not moved since'))).toHaveLength(1);
  });
});
