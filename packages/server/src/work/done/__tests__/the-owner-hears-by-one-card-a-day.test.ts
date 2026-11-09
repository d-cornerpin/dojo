// The owner hears about a stuck task by one dashboard card (what is stuck, since when, what was tried),
// never a text: no sooner than 15 minutes after the hand-in, and at most once per task per day. The card
// is the ask his own words may then decide by.
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../../db/connection.js', async () => (await import('./helpers/done-db.js')).connectionMock());
vi.mock('../../../gateway/ws.js', async () => (await import('./helpers/ladder-world.js')).wsMock());
vi.mock('../../../agent/runtime.js', async () => (await import('./helpers/ladder-world.js')).runtimeMock());
vi.mock('../../../tracker/pm-agent.js', async (orig) => ({ ...(await orig<object>()), armDebouncedReview: vi.fn() }));
vi.mock('../../../services/imessage-bridge.js', async (orig) => ({ ...(await orig<object>()), sendAlert: (await import('./helpers/ladder-world.js')).texts }));
vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 });

import { runLadder } from '../ladder.js';
import { runPMReview } from '../../../tracker/pm-agent.js';
import { standingOwnerNotices } from '../../../healer/owner-notice-kinds.js';
import { dismissOwnerNotice } from '../../../healer/owner-notices.js';
import { freshBoard, handedIn, eventCount, PM, MAIN, TASK } from './helpers/decision-world.js';
import { cards, texts, pmCanRun, resetLadderWorld, MIN } from './helpers/ladder-world.js';

beforeEach(async () => {
  resetLadderWorld();
  freshBoard(MAIN); pmCanRun(PM);
  await handedIn(MAIN);
  await runPMReview();
  await runPMReview();
});

const stallCards = (): typeof cards => cards.filter((c) => c.cardKey === `stall:${TASK}`);

describe('the owner hears by one card a day', () => {
  it('no card before 15 minutes after the hand-in, then exactly one, however often the ladder looks', async () => {
    await runLadder(Date.now() + 10 * MIN);
    expect(stallCards()).toEqual([]);
    await runLadder(Date.now() + 16 * MIN);
    await runLadder(Date.now() + 20 * MIN);
    await runLadder(Date.now() + 60 * MIN);
    expect(stallCards()).toHaveLength(1);
    expect(stallCards()[0].error).toMatch(/^"Write the report" has been handed in and waiting for a decision since .+\. Tried: a project manager review with no verdict \(2 times\)\./);
    expect(eventCount('validation_escalated')).toBe(1);
    dismissOwnerNotice(`stall:${TASK}`);
    await runPMReview();   // another miss: the card's "Tried:" count moves
    await runLadder(Date.now() + 3 * 60 * MIN);
    expect(stallCards(), 'a card he dismissed is not pushed again the same day').toHaveLength(1);
  });

  it('the card stands on the next dashboard load, and the owner is never texted', async () => {
    await runLadder(Date.now() + 16 * MIN);
    expect(standingOwnerNotices().map((c) => c.cardKey)).toContain(`stall:${TASK}`);
    expect(texts).not.toHaveBeenCalled();
  });
});
