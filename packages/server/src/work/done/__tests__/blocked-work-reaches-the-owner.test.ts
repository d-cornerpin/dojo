// Blocked work reaches the owner (owner ruling OR-PM-1v2: "the path is for that to get escalated to the
// user which should already happen after some failures/time"). A blocked hold with no progress is a stall:
// its worker is hinted with the reason, then the PM is told, then the owner gets one card saying what is
// stuck, since when and what was tried. A task the owner cancelled reaches nobody, and healthy work that
// keeps moving never escalates.
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../../db/connection.js', async () => (await import('./helpers/done-db.js')).connectionMock());
vi.mock('../../../gateway/ws.js', async () => (await import('./helpers/ladder-world.js')).wsMock());
vi.mock('../../../agent/runtime.js', async () => (await import('./helpers/ladder-world.js')).runtimeMock());
vi.mock('../../../tracker/pm-agent.js', async (orig) => ({ ...(await orig<object>()), armDebouncedReview: vi.fn() }));
vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 });

import { runLadder, LADDER_ENTRY } from '../ladder.js';
import { setHold } from '../hold.js';
import { decide } from '../decide.js';
import { runPMReview } from '../../../tracker/pm-agent.js';
import { freshBoard, PM, WORKER, TASK } from './helpers/decision-world.js';
import { hintsTo, cards, entries, resetLadderWorld, anchorBack, pmCanRun, pmReviewEnded, turnTaken, MIN } from './helpers/ladder-world.js';
import { doneDb } from './helpers/done-db.js';

const REASON = 'waiting for the landlord to send the signed lease';
const stallCards = (): typeof cards => cards.filter((c) => c.cardKey === `stall:${TASK}`);
/** The ladder's own entries, the hold and the ladder's first run, moved back in time so its bounds have passed. */
const backdate = (ms: number): void => {
  doneDb().prepare('UPDATE work_events SET created_at = created_at - ? WHERE work_id = ?').run(ms, TASK);
  doneDb().prepare('UPDATE work SET updated_at = updated_at - ?, opened_at = opened_at - ? WHERE id = ?').run(ms, ms, TASK);
  doneDb().prepare("UPDATE _migrations SET applied_at = datetime(applied_at, ?) WHERE name LIKE '901%'").run(`-${ms / 1000} seconds`);
};

/** One sweep after the bounds have passed; the worker's turn takes each hint, and the PM's review runs once marked. */
async function step(): Promise<void> {
  backdate(6 * MIN);
  await runLadder();
  turnTaken(WORKER);
  if (entries(TASK, LADDER_ENTRY.pm) > 0) { await runPMReview(); pmReviewEnded(PM); }
}

beforeEach(() => { freshBoard(); pmCanRun(PM); anchorBack(60 * MIN); resetLadderWorld(); expect(setHold(TASK, 'blocked', REASON, WORKER).ok).toBe(true); });

describe('blocked work reaches the owner', () => {
  it('hint with the reason, then the PM, then one card for the owner', async () => {
    await step();
    expect(hintsTo(WORKER)).toHaveLength(1);
    expect(hintsTo(WORKER)[0]).toContain(REASON);
    await step();
    expect(entries(TASK, LADDER_ENTRY.pm)).toBe(1);
    expect(stallCards()).toEqual([]);
    await step();
    expect(stallCards()).toHaveLength(1);
    expect(stallCards()[0].error).toMatch(/^"Write the report" has been held since .+: blocked by its worker, waiting on: waiting for the landlord to send the signed lease\. Tried: .*a hint to its worker.*the project manager was told/);
    await step();
    expect(stallCards()).toHaveLength(1);
  });

  it('a task that stalls again within a day of the card is hinted and told to the PM again, never carded twice that day', async () => {
    for (let i = 0; i < 3; i++) await step();
    expect(stallCards()).toHaveLength(1);
    doneDb().prepare("INSERT INTO work_events (work_id, kind, actor, payload, created_at) VALUES (?, 'activity', ?, '{}', ?)").run(TASK, WORKER, Date.now() + 1000);   // it moves after the card
    await step();
    expect(hintsTo(WORKER), 'the new stall is hinted on schedule').toHaveLength(2);
    await step();
    expect(entries(TASK, LADDER_ENTRY.pm), 'and the PM is told again').toBe(2);
    await step();
    expect(stallCards(), 'the owner is not carded twice for the task within the day').toHaveLength(1);
  });

  it('a task the owner cancelled reaches nobody', async () => {
    expect(decide({ workId: TASK, deciderAgentId: null, verdict: 'cancel', reason: 'The move is off' }).kind).toBe('decided');
    backdate(60 * MIN);
    await runLadder();
    expect(hintsTo(WORKER)).toEqual([]);
    expect(cards).toEqual([]);
  });

  it('work that keeps moving never escalates', async () => {
    for (let i = 0; i < 4; i++) {
      backdate(4 * MIN);
      doneDb().prepare("INSERT INTO work_events (work_id, kind, actor, payload, created_at) VALUES (?, 'activity', ?, '{}', ?)").run(TASK, WORKER, Date.now());
      await runLadder();
    }
    expect(hintsTo(WORKER)).toEqual([]);
    expect(cards).toEqual([]);
  });
});
