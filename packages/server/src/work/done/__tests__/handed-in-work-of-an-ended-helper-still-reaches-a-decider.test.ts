// A helper hands its task in and is ended. The row stays on the ladder: two PM reviews with no verdict
// bring the main agent in, and if the main agent lets it sit, the owner gets the card.
import { describe, it, expect, vi } from 'vitest';

vi.mock('../../../db/connection.js', async () => (await import('./helpers/done-db.js')).connectionMock());
vi.mock('../../../gateway/ws.js', async () => (await import('./helpers/ladder-world.js')).wsMock());
vi.mock('../../../agent/runtime.js', async () => (await import('./helpers/ladder-world.js')).runtimeMock());
vi.mock('../../../tracker/pm-agent.js', async (orig) => ({ ...(await orig<object>()), armDebouncedReview: vi.fn() }));
vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 });

import { runLadder } from '../ladder.js';
import { runPMReview } from '../../../tracker/pm-agent.js';
import { freshBoard, handedIn, PM, MAIN, WORKER, TASK } from './helpers/decision-world.js';
import { hintsTo, cards, pmCanRun, resetLadderWorld, anchorBack, MIN } from './helpers/ladder-world.js';
import { doneDb } from './helpers/done-db.js';

describe('handed-in work of an ended helper still reaches a decider', () => {
  it('the PM misses twice, the main agent is told, then the owner gets the card', async () => {
    freshBoard(); pmCanRun(PM); resetLadderWorld(); anchorBack(2 * 60 * MIN);
    await handedIn();
    doneDb().prepare("UPDATE agents SET status = 'terminated' WHERE id = ?").run(WORKER);
    await runPMReview();
    await runPMReview();
    await runLadder(Date.now() + MIN);
    expect(hintsTo(MAIN)).toHaveLength(1);
    expect(hintsTo(MAIN)[0]).toContain('is yours to decide');
    expect(cards).toEqual([]);
    await runLadder(Date.now() + 20 * MIN);
    expect(cards.filter((c) => c.cardKey === `stall:${TASK}`)).toHaveLength(1);
  });
});
