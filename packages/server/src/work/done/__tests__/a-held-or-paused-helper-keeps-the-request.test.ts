// The owner's hold and the engine's "waiting for a reply" hold keep the request on the task, card or not; a paused
// helper keeps it too. A hold the helper set itself is a stall: its card ends the request. The owner's cancel ends it as his.
// The main agent's own kept task is laddered like any other, and its card never ends the request.
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../../db/connection.js', async () => (await import('./helpers/done-db.js')).connectionMock());
vi.mock('../../../gateway/ws.js', async () => (await import('./helpers/ladder-world.js')).wsMock());
vi.mock('../../../agent/runtime.js', async () => (await import('./helpers/ladder-world.js')).runtimeMock());
vi.mock('../../../tracker/pm-agent.js', async (orig) => ({ ...(await orig<object>()), armDebouncedReview: vi.fn() }));
vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 });

import { runLadder } from '../ladder.js';
import { setHold } from '../hold.js';
import { decide } from '../decide.js';
import { runPMReview } from '../../../tracker/pm-agent.js';
import { recordValidationEscalation } from '../../tracker-store.js';
import { judgeKeptRequests } from '../../../agent/a2a-transport.js';
import { freshBoard, PM, MAIN, WORKER, TASK } from './helpers/decision-world.js';
import { cards, hintsTo, keptRequest, keptState, pmCanRun, pmReviewEnded, resetLadderWorld, turnTaken, anchorBack, MIN } from './helpers/ladder-world.js';
import { doneDb } from './helpers/done-db.js';

/** Every step of the ladder taken, each turn ending unmoved, out to a day. */
async function allTheWay(): Promise<void> {
  for (const at of [6, 12, 20, 40, 1440]) {
    await runLadder(Date.now() + at * MIN);
    turnTaken(WORKER);
    await runPMReview();
    pmReviewEnded(PM);
  }
}

let ask = '';
beforeEach(async () => { freshBoard(); pmCanRun(PM); anchorBack(2 * 60 * MIN); resetLadderWorld(); ask = await keptRequest(WORKER, TASK, MAIN); });

describe('a held or paused helper keeps the request', () => {
  it('the owner\'s hold: kept, and his cancel ends the request as called off by him', async () => {
    expect(setHold(TASK, 'paused', 'until the budget is signed', 'owner').ok).toBe(true);
    await allTheWay();
    expect(await keptState(ask)).toEqual(['claimed', 'open']);
    expect(decide({ workId: TASK, deciderAgentId: null, verdict: 'cancel', reason: 'The report is no longer needed' }).kind).toBe('decided');
    expect(await keptState(ask)).toEqual(['abandoned', 'abandoned']);
  });

  it('the engine\'s "waiting for a reply" hold: carded, still kept', async () => {
    expect(setHold(TASK, 'paused', 'Waiting for a reply to its last message.', 'engine').ok).toBe(true);
    await allTheWay();
    expect([cards.length, ...(await keptState(ask))]).toEqual([1, 'claimed', 'open']);
  });

  it('a paused helper: no step at all, kept', async () => {
    doneDb().prepare("UPDATE agents SET status = 'paused' WHERE id = ?").run(WORKER);
    await allTheWay();
    expect([cards.length, ...(await keptState(ask))]).toEqual([0, 'claimed', 'open']);
  });

  it('a hold the helper set itself: its card ends the request', async () => {
    expect(setHold(TASK, 'blocked', 'waiting for the printer', WORKER).ok).toBe(true);
    await allTheWay();
    expect([cards.length, ...(await keptState(ask))]).toEqual([1, 'failed', 'abandoned']);
  });

  it("the main agent's own kept task: reminded while its delegation is open, and its card keeps the request", async () => {
    freshBoard(MAIN); anchorBack(2 * 60 * MIN); resetLadderWorld();
    ask = await keptRequest(WORKER, TASK, MAIN);
    doneDb().prepare("UPDATE work SET state = 'blocked' WHERE id = ?").run(ask);   // held on its delegation, as a delegating turn leaves it
    await runLadder(Date.now() + 6 * MIN);
    expect(hintsTo(MAIN)).toHaveLength(1);
    recordValidationEscalation(TASK, 'engine', null);
    await judgeKeptRequests(WORKER, 'thread-kept');
    expect(await keptState(ask)).toEqual(['blocked', 'open']);
  });
});
