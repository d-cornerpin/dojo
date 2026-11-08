// A Working task with no progress past its worker's patience bound gets one engine hint, and never a
// second for the same step. A blocked hold is a stall: its hint carries the hold's reason.
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../../db/connection.js', async () => (await import('./helpers/done-db.js')).connectionMock());
vi.mock('../../../gateway/ws.js', async () => (await import('./helpers/ladder-world.js')).wsMock());
vi.mock('../../../agent/runtime.js', async () => (await import('./helpers/ladder-world.js')).runtimeMock());
vi.mock('../../../tracker/pm-agent.js', async (orig) => ({ ...(await orig<object>()), armDebouncedReview: vi.fn() }));
vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 });

import { runLadder, ladderStep } from '../ladder.js';
import { setHold } from '../hold.js';
import { freshBoard, WORKER, TASK } from './helpers/decision-world.js';
import { hintsTo, resetLadderWorld, MIN } from './helpers/ladder-world.js';
import { doneDb } from './helpers/done-db.js';

beforeEach(() => { freshBoard(); resetLadderWorld(); });

describe('a stalled task gets one hint', () => {
  it('no hint inside the bound, one past it, and none again on later sweeps of the same step', async () => {
    await runLadder(Date.now() + 2 * MIN);
    expect(hintsTo(WORKER)).toEqual([]);
    await runLadder(Date.now() + 6 * MIN);
    expect(hintsTo(WORKER)).toHaveLength(1);
    expect(hintsTo(WORKER)[0]).toMatch(/^\[Engine hint: "Write the report" has not moved since .*hand it in with work_update\(action="hand_in"\)/);
    expect(ladderStep(TASK, Date.now() + 2 * MIN)).toEqual({ reached: 1, due: null });
    await runLadder(Date.now() + 7 * MIN);
    await runLadder(Date.now() + 8 * MIN);
    expect(hintsTo(WORKER)).toHaveLength(1);
  });

  it('progress restarts the clock: a task that moved is not hinted', async () => {
    await runLadder(Date.now() + 6 * MIN);
    expect(hintsTo(WORKER)).toHaveLength(1);
    doneDb().prepare("UPDATE work_events SET created_at = created_at - 1000 WHERE work_id = ?").run(TASK);
    expect(setHold(TASK, 'blocked', 'waiting for the vendor to send the price list', WORKER).ok).toBe(true);
    expect(ladderStep(TASK, Date.now() + 2 * MIN)).toEqual({ reached: 0, due: null });
  });

  it('a blocked hold is a stall, and its hint names the reason', async () => {
    expect(setHold(TASK, 'blocked', 'waiting for the vendor to send the price list', WORKER).ok).toBe(true);
    await runLadder(Date.now() + 6 * MIN);
    expect(hintsTo(WORKER)).toHaveLength(1);
    expect(hintsTo(WORKER)[0]).toContain('held blocked since');
    expect(hintsTo(WORKER)[0]).toContain('waiting for the vendor to send the price list');
  });
});
