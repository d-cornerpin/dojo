// A hand-in with no verdict after two PM reviews goes to the next decider: the main agent for another
// agent's task (woken with the hand-in), the owner's card for the main agent's own; never before. Three
// send-backs bring the next decider in early, with the reasons so far.
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../../db/connection.js', async () => (await import('./helpers/done-db.js')).connectionMock());
vi.mock('../../../gateway/ws.js', async () => (await import('./helpers/ladder-world.js')).wsMock());
vi.mock('../../../agent/runtime.js', async () => (await import('./helpers/ladder-world.js')).runtimeMock());
vi.mock('../../../tracker/pm-agent.js', async (orig) => ({ ...(await orig<object>()), armDebouncedReview: vi.fn() }));
vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 });

import { runLadder } from '../ladder.js';
import { whoDecides } from '../who-decides.js';
import { runPMReview } from '../../../tracker/pm-agent.js';
import { freshBoard, handedIn, call, stateOf, PM, MAIN, WORKER, TASK } from './helpers/decision-world.js';
import { hintsTo, cards, pmCanRun, resetLadderWorld, anchorBack, MIN } from './helpers/ladder-world.js';

beforeEach(() => resetLadderWorld());

async function twoReviewsWithNoVerdict(): Promise<void> {
  await runPMReview();
  await runPMReview();
}

describe('an undecided hand-in goes to the next decider', () => {
  it("another agent's task reaches the main agent after two reviews with no verdict, and not before", async () => {
    freshBoard(); pmCanRun(PM);
    await handedIn();
    await runPMReview();
    await runLadder(Date.now() + MIN);
    expect(whoDecides(TASK)).toEqual({ kind: 'agent', agentId: PM });
    expect(hintsTo(MAIN)).toEqual([]);
    await runPMReview();
    expect(whoDecides(TASK)).toEqual({ kind: 'agent', agentId: MAIN });
    await runLadder(Date.now() + MIN);
    expect(hintsTo(MAIN)).toHaveLength(1);
    expect(hintsTo(MAIN)[0]).toContain(`"Write the report" was handed in by ${WORKER} and is yours to decide`);
    expect(hintsTo(MAIN)[0]).toContain('work_validate(action="open_proof"');
    await runLadder(Date.now() + 2 * MIN);
    expect(hintsTo(MAIN)).toHaveLength(1);
    expect(hintsTo(WORKER), 'a handed-in task is never put back to its worker').toEqual([]);
    expect(cards).toEqual([]);
  });

  it("the main agent's own task goes to the owner's card, never to the main agent", async () => {
    freshBoard(MAIN); pmCanRun(PM); anchorBack(2 * 60 * MIN);
    await handedIn(MAIN);
    await twoReviewsWithNoVerdict();
    expect(whoDecides(TASK)).toEqual({ kind: 'owner' });
    await runLadder(Date.now() + 16 * MIN);
    expect(cards.filter((c) => c.cardKey === `stall:${TASK}`)).toHaveLength(1);
    expect(hintsTo(MAIN)).toEqual([]);
  });

  it('a third send-back brings the next decider in early, with the reasons so far', async () => {
    freshBoard(); pmCanRun(PM);
    const reasons = ['The totals page is missing', 'The chart has no labels', 'The summary is cut off'];
    for (const reason of reasons) {
      await handedIn();
      const r = await call(PM, 'work_validate', { action: 'decide', task_id: TASK, verdict: 'send_back', reason });
      expect(r.isError, r.content).toBe(false);
    }
    expect(stateOf()).toBe('sent_back');
    expect(whoDecides(TASK)).toEqual({ kind: 'agent', agentId: MAIN });
    await runLadder(Date.now());
    expect(hintsTo(MAIN)).toHaveLength(1);
    for (const reason of reasons) expect(hintsTo(MAIN)[0]).toContain(reason);
  });

  it("three quick send-backs on the main agent's own task card the owner no sooner than 15 minutes after the hand-in", async () => {
    freshBoard(MAIN); pmCanRun(PM); anchorBack(2 * 60 * MIN);
    for (const reason of ['The totals page is missing', 'The chart has no labels', 'The summary is cut off']) {
      await handedIn(MAIN);
      expect((await call(PM, 'work_validate', { action: 'decide', task_id: TASK, verdict: 'send_back', reason })).isError).toBe(false);
    }
    await runLadder(Date.now() + MIN);
    expect(cards).toEqual([]);
    await runLadder(Date.now() + 16 * MIN);
    expect(cards.filter((c) => c.cardKey === `stall:${TASK}`)).toHaveLength(1);
  });
});
