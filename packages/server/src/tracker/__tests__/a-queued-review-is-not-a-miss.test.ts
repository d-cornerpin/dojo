// A PM review that never ran is not a miss. A review turn queued behind a run in flight is judged on that
// queued turn once it has run: it records one miss per hand-in it held and did not decide, none when the
// queued turn never ran, and none for a row it decided. A PM that cannot run at all is a review that gave
// no verdict, so a hand-in never waits on a PM that is gone.
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../db/connection.js', async () => (await import('../../work/done/__tests__/helpers/done-db.js')).connectionMock());
vi.mock('../../gateway/ws.js', async () => (await import('../../work/done/__tests__/helpers/ladder-world.js')).wsMock());
vi.mock('../../agent/runtime.js', async () => (await import('../../work/done/__tests__/helpers/ladder-world.js')).runtimeMock());
vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 });

import { runPMReview } from '../pm-agent.js';
import { decide } from '../../work/done/decide.js';
import { REVIEW_MISS_ENTRY } from '../../work/done/who-decides.js';
import { freshBoard, handedIn, PM, TASK } from '../../work/done/__tests__/helpers/decision-world.js';
import { entries, pmCanRun, resetLadderWorld, turn } from '../../work/done/__tests__/helpers/ladder-world.js';

const misses = (): number => entries(TASK, REVIEW_MISS_ENTRY);

beforeEach(async () => { resetLadderWorld(); freshBoard(); pmCanRun(PM); await handedIn(); });

describe('a queued review is not a miss', () => {
  it('a review whose turn ran and decided nothing is one miss', async () => {
    await runPMReview();
    expect(misses()).toBe(1);
  });

  it('a review queued behind a run in flight, whose queued turn never ran, is no miss', async () => {
    Object.assign(turn, { asked: 'queued', queued: 'not-run' });
    await runPMReview();
    expect(misses()).toBe(0);
  });

  it('a review queued behind a run in flight is judged on the queued turn once it has run', async () => {
    Object.assign(turn, { asked: 'queued', queued: 'ran' });
    await runPMReview();
    expect(misses()).toBe(1);
  });

  it('a row decided during the review turn gets no miss', async () => {
    turn.during = () => { decide({ workId: TASK, deciderAgentId: null, verdict: 'cancel', reason: 'The owner no longer needs it' }); };
    await runPMReview();
    expect(misses()).toBe(0);
  });

  it('a PM that cannot run is a review with no verdict', async () => {
    freshBoard();
    await handedIn();
    await runPMReview();
    expect(misses()).toBe(1);
  });
});
