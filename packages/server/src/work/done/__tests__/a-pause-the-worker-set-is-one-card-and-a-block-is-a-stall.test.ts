// A pause the worker set on its own task waits on the owner: no hint to the worker and no ask of the PM, one card for
// him naming what it waits on. A block the worker set (waiting on a vendor) is a stall: its worker is hinted with the
// reason, then the PM is told (its report names the block, and its retask lifts it), then the owner's card.
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../../db/connection.js', async () => (await import('./helpers/done-db.js')).connectionMock());
vi.mock('../../../gateway/ws.js', async () => (await import('./helpers/ladder-world.js')).wsMock());
vi.mock('../../../agent/runtime.js', async () => (await import('./helpers/ladder-world.js')).runtimeMock());
vi.mock('../../../tracker/pm-agent.js', async (orig) => ({ ...(await orig<object>()), armDebouncedReview: vi.fn() }));
vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 });

import { runLadder, LADDER_ENTRY } from '../ladder.js';
import { holdOf } from '../hold.js';
import { runPMReview } from '../../../tracker/pm-agent.js';
import { freshBoard, call, PM, WORKER, TASK } from './helpers/decision-world.js';
import { hintsTo, cards, entries, lastReport, resetLadderWorld, anchorBack, pmCanRun, pmReviewEnded, turnTaken, MIN } from './helpers/ladder-world.js';

const REASON = 'waiting for the vendor to send the tracking number';
const stallCards = () => cards.filter((c) => c.cardKey === `stall:${TASK}`);

beforeEach(() => { freshBoard(); pmCanRun(PM); anchorBack(2 * 60 * MIN); resetLadderWorld(); });

describe('a pause the worker set is one card, and a block is a stall', () => {
  it('paused for the owner\'s answers: no hint, no PM, one card naming what it waits on', async () => {
    expect((await call(WORKER, 'work_update', { action: 'status', task_id: TASK, status: 'paused', notes: 'Waiting on the owner\'s answers.' })).isError).toBe(false);
    for (const at of [6, 12, 18, 40]) await runLadder(Date.now() + at * MIN);
    expect([hintsTo(WORKER).length, entries(TASK, LADDER_ENTRY.pm), stallCards().length]).toEqual([0, 0, 1]);
    expect(stallCards()[0].error).toContain('paused by its worker, waiting on: Waiting on the owner\'s answers');
  });

  it('blocked on a vendor: hint with the reason, then the PM, then the owner\'s card', async () => {
    expect((await call(WORKER, 'work_update', { action: 'status', task_id: TASK, status: 'blocked', notes: `${REASON}.` })).isError).toBe(false);
    await runLadder(Date.now() + 6 * MIN);
    expect(hintsTo(WORKER)).toHaveLength(1);
    expect(hintsTo(WORKER)[0]).toContain(`blocked by its worker, waiting on: ${REASON}`);
    turnTaken(WORKER);
    await runLadder(Date.now() + 12 * MIN);
    expect(entries(TASK, LADDER_ENTRY.pm)).toBe(1);
    await runPMReview();
    expect(lastReport(PM)).toContain(`It is held: blocked by its worker, waiting on: ${REASON}.`);
    pmReviewEnded(PM);
    await runLadder(Date.now() + 18 * MIN);
    expect(stallCards()).toHaveLength(1);
    expect(stallCards()[0].error).toContain(`blocked by its worker, waiting on: ${REASON}`);
  });

  it('blocked on a wait that is not real: the PM\'s retask lifts the block', async () => {
    await call(WORKER, 'work_update', { action: 'status', task_id: TASK, status: 'blocked', notes: 'waiting for the paint supplier to confirm the colour' });
    await runLadder(Date.now() + 6 * MIN);
    turnTaken(WORKER);
    await runLadder(Date.now() + 12 * MIN);
    await runPMReview();
    const r = await call(PM, 'work_validate', { action: 'retask', task_id: TASK, directive: 'The supplier confirmed blue this morning; go on with blue.' });
    expect(r.isError, r.content).toBe(false);
    expect(holdOf(TASK)).toBeNull();
  });
});
