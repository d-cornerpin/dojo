// A pause the worker set on its own task is a stall, even "until" a far date: its worker is hinted with the
// reason and the date, then the PM is told, then the owner's card says what the task is waiting on and until when.
import { describe, it, expect, vi } from 'vitest';

vi.mock('../../../db/connection.js', async () => (await import('./helpers/done-db.js')).connectionMock());
vi.mock('../../../gateway/ws.js', async () => (await import('./helpers/ladder-world.js')).wsMock());
vi.mock('../../../agent/runtime.js', async () => (await import('./helpers/ladder-world.js')).runtimeMock());
vi.mock('../../../tracker/pm-agent.js', async (orig) => ({ ...(await orig<object>()), armDebouncedReview: vi.fn() }));
vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 });

import { runLadder, LADDER_ENTRY } from '../ladder.js';
import { runPMReview } from '../../../tracker/pm-agent.js';
import { freshBoard, call, PM, WORKER, TASK } from './helpers/decision-world.js';
import { hintsTo, cards, entries, resetLadderWorld, anchorBack, pmCanRun, pmReviewEnded, turnTaken, MIN } from './helpers/ladder-world.js';

const REASON = 'waiting for the vendor to send the tracking number';
const UNTIL = '2099-01-01 09:00 UTC';

describe('a pause the worker set is a stall', () => {
  it('hint with the reason and date, then the PM, then the owner\'s card naming what it waits on and until when', async () => {
    freshBoard(); pmCanRun(PM); anchorBack(2 * 60 * MIN); resetLadderWorld();
    expect((await call(WORKER, 'work_update', { action: 'status', task_id: TASK, status: 'paused', notes: `${REASON}.`, resume_at: '2099-01-01T09:00:00Z' })).isError).toBe(false);
    await runLadder(Date.now() + 6 * MIN);
    expect(hintsTo(WORKER)).toHaveLength(1);
    expect(hintsTo(WORKER)[0]).toContain(`paused by its worker, waiting on: ${REASON}, until ${UNTIL}`);
    turnTaken(WORKER);
    await runLadder(Date.now() + 12 * MIN);
    expect(entries(TASK, LADDER_ENTRY.pm)).toBe(1);
    await runPMReview();
    pmReviewEnded(PM);
    await runLadder(Date.now() + 18 * MIN);
    const card = cards.filter((c) => c.cardKey === `stall:${TASK}`);
    expect(card).toHaveLength(1);
    expect(card[0].error).toContain(`has been held since`);
    expect(card[0].error).toContain(`paused by its worker, waiting on: ${REASON}, until ${UNTIL}`);
  });
});
