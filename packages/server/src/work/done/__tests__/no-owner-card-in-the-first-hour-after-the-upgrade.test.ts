// The owner gets no stall card in the first hour after the upgrade, even when every earlier step has passed.
import { describe, it, expect, vi } from 'vitest';

vi.mock('../../../db/connection.js', async () => (await import('./helpers/done-db.js')).connectionMock());
vi.mock('../../../gateway/ws.js', async () => (await import('./helpers/ladder-world.js')).wsMock());
vi.mock('../../../agent/runtime.js', async () => (await import('./helpers/ladder-world.js')).runtimeMock());
vi.mock('../../../tracker/pm-agent.js', async (orig) => ({ ...(await orig<object>()), armDebouncedReview: vi.fn() }));
vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 });

import { runLadder, LADDER_ENTRY } from '../ladder.js';
import { runPMReview } from '../../../tracker/pm-agent.js';
import { freshBoard, PM, WORKER, TASK } from './helpers/decision-world.js';
import { hintsTo, cards, entries, resetLadderWorld, pmCanRun, pmReviewEnded, turnTaken, MIN } from './helpers/ladder-world.js';

describe('no owner card in the first hour after the upgrade', () => {
  it('hint and PM pass on schedule; the card waits for the hour', async () => {
    freshBoard(); pmCanRun(PM); resetLadderWorld();
    await runLadder(Date.now() + 6 * MIN);
    expect(hintsTo(WORKER)).toHaveLength(1);
    turnTaken(WORKER);
    await runLadder(Date.now() + 12 * MIN);
    expect(entries(TASK, LADDER_ENTRY.pm)).toBe(1);
    await runPMReview();
    pmReviewEnded(PM);
    for (const at of [20, 40, 59]) await runLadder(Date.now() + at * MIN);
    expect(cards).toEqual([]);
    await runLadder(Date.now() + 61 * MIN);
    expect(cards.filter((c) => c.cardKey === `stall:${TASK}`)).toHaveLength(1);
  });
});
