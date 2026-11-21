// A stall is decided by the PM's finished review, never by time: the owner's card, and with it the end of the
// request kept on the task, comes only after a PM review that began after the stall was marked has ended with the
// worker still idle. A retask keeps the work: the climb starts again and the PM decides the next round. A review that
// did not list the row, or a mark written while a review runs, does not change what counts. A PM that cannot run is
// skipped. A helper whose run the Dojo flagged SILENT is looked at, but its request never ends while the run is in flight.
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../../db/connection.js', async () => (await import('./helpers/done-db.js')).connectionMock());
vi.mock('../../../gateway/ws.js', async () => (await import('./helpers/ladder-world.js')).wsMock());
vi.mock('../../../agent/runtime.js', async () => (await import('./helpers/ladder-world.js')).runtimeMock());
vi.mock('../../../tracker/pm-agent.js', async (orig) => ({ ...(await orig<object>()), armDebouncedReview: vi.fn() }));
vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 });

import { runLadder, LADDER_ENTRY } from '../ladder.js';
import { runPMReview } from '../../../tracker/pm-agent.js';
import { activeRuns } from '../../../agent/shared-state.js';
import { sweepExpiredJoins } from '../../../agent/a2a-transport.js';
import { freshBoard, call, PM, MAIN, WORKER, TASK } from './helpers/decision-world.js';
import { cards, entries, keptRequest, keptState, pmCanRun, pmReviewEnded, resetLadderWorld, turnTaken, anchorBack, MIN } from './helpers/ladder-world.js';
import { doneDb } from './helpers/done-db.js';

const RETASK = 'Send the owner the draft you already have, then finish the totals.';
const stallCards = (): number => cards.filter((c) => c.cardKey === `stall:${TASK}`).length;
const agentLines = (): number => (doneDb().prepare("SELECT COUNT(*) AS n FROM messages WHERE agent_id = ? AND origin_intent = 'fanout_join'").get(MAIN) as { n: number }).n;

/** The reminder, its turn ending unmoved, and the PM told. */
async function stalledToThePM(): Promise<void> {
  await runLadder(Date.now() + 6 * MIN);
  turnTaken(WORKER);
  await runLadder(Date.now() + 12 * MIN);
  expect(entries(TASK, LADDER_ENTRY.pm)).toBe(1);
}

let ask = '';
beforeEach(async () => { freshBoard(); pmCanRun(PM); anchorBack(2 * 60 * MIN); resetLadderWorld(); ask = await keptRequest(WORKER, TASK, MAIN); });

describe("the PM's finished review decides a stall", () => {
  it('no card while the review has not run, however long; once it ends with no move, one card, one end, one line', async () => {
    await stalledToThePM();
    for (const at of [20, 60, 600, 6000]) await runLadder(Date.now() + at * MIN);
    expect([stallCards(), ...(await keptState(ask))]).toEqual([0, 'claimed', 'open']);
    await runPMReview();
    pmReviewEnded(PM);
    await runLadder(Date.now() + 20 * MIN);
    await runLadder(Date.now() + 40 * MIN);
    expect([stallCards(), ...(await keptState(ask)), agentLines()]).toEqual([1, 'failed', 'abandoned', 1]);
  });

  it('a review whose report came before the mark does not count', async () => {
    await runPMReview();   // nothing marked yet: no report
    doneDb().prepare("INSERT INTO messages (id, agent_id, role, content, lane, origin_intent, served_by_turn, created_at) VALUES ('old-review', ?, 'user', 'Tracker review', 'events', 'pm_review', 7, ?)").run(PM, Date.now() - 60 * MIN);
    doneDb().prepare("INSERT INTO turns (agent_id, turn_number, started_at, ended_at, answered, exit_reason) VALUES (?, 7, datetime('now', '-1 hour'), datetime('now', '-1 hour'), 1, 'answered')").run(PM);
    await stalledToThePM();
    await runLadder(Date.now() + 30 * MIN);
    expect(stallCards()).toBe(0);
  });

  it('a retask keeps the work: the climb starts again, and the next review that lets it go brings the card', async () => {
    await stalledToThePM();
    await runPMReview();
    expect((await call(PM, 'work_validate', { action: 'retask', task_id: TASK, directive: RETASK })).content).not.toMatch(/^(Error|Refused)/);
    pmReviewEnded(PM);
    turnTaken(WORKER);
    await runLadder(Date.now() + 30 * MIN);
    expect([stallCards(), ...(await keptState(ask))]).toEqual([0, 'claimed', 'open']);
    turnTaken(WORKER);
    await runLadder(Date.now() + 40 * MIN);
    await runPMReview();
    pmReviewEnded(PM);
    await runLadder(Date.now() + 50 * MIN);
    expect([stallCards(), ...(await keptState(ask))]).toEqual([1, 'failed', 'abandoned']);
  });

  it('a review still running when a new mark is written counts; a review that did not list the row does not', async () => {
    await stalledToThePM();
    doneDb().prepare("INSERT INTO messages (id, agent_id, role, content, lane, origin_intent, served_by_turn, created_at) VALUES ('other-review', ?, 'user', 'Tracker review of other rows', 'events', 'pm_review', 8, ?)").run(PM, Date.now());
    doneDb().prepare("INSERT INTO turns (agent_id, turn_number, started_at, ended_at, answered, exit_reason) VALUES (?, 8, datetime('now'), datetime('now'), 1, 'answered')").run(PM);
    await runLadder(Date.now() + 30 * MIN);
    expect(stallCards(), 'not listed').toBe(0);
    await runPMReview();
    doneDb().prepare("INSERT INTO work_events (work_id, kind, actor, payload, created_at) VALUES (?, 'audit', 'engine', json_object('entry_kind', ?), ?)").run(TASK, LADDER_ENTRY.pm, Date.now() + 5000);
    pmReviewEnded(PM);
    await runLadder(Date.now() + 40 * MIN);
    expect(stallCards(), 'the review that listed it ended').toBe(1);
  });

  it('a SILENT run is looked at, never ended while in flight: the card waits for the run to end', async () => {
    activeRuns.add(WORKER);
    doneDb().prepare("UPDATE agents SET silent_notice = '{}' WHERE id = ?").run(WORKER);
    try {
      await stalledToThePM();
      await runPMReview();
      pmReviewEnded(PM);
      await runLadder(Date.now() + 30 * MIN);
      expect([stallCards(), ...(await keptState(ask))]).toEqual([1, 'claimed', 'open']);
    } finally { activeRuns.delete(WORKER); }
    doneDb().prepare('UPDATE work SET ttl_at = ? WHERE id = ?').run(Date.now() - 1, ask);   // the next look, once the run is over
    await sweepExpiredJoins();
    expect(await keptState(ask)).toEqual(['failed', 'abandoned']);
  });

  it('a directive turn that moves the task ends the stall, and nothing is sent', async () => {
    await stalledToThePM();
    await runPMReview();
    expect((await call(PM, 'work_validate', { action: 'retask', task_id: TASK, directive: RETASK })).content).not.toMatch(/^(Error|Refused)/);
    pmReviewEnded(PM);
    turnTaken(WORKER);
    doneDb().prepare("INSERT INTO work_events (work_id, kind, actor, payload, created_at) VALUES (?, 'activity', ?, '{}', ?)").run(TASK, WORKER, Date.now());
    await runLadder(Date.now() + 30 * MIN);
    expect([stallCards(), ...(await keptState(ask))]).toEqual([0, 'claimed', 'open']);
  });

  it('a PM that cannot run is skipped: the idle worker after its reminder is the decision', async () => {
    doneDb().prepare("UPDATE agents SET status = 'paused' WHERE id = ?").run(PM);
    await runLadder(Date.now() + 6 * MIN);
    turnTaken(WORKER);
    await runLadder(Date.now() + 20 * MIN);
    expect([entries(TASK, LADDER_ENTRY.pm), stallCards(), ...(await keptState(ask))]).toEqual([0, 1, 'failed', 'abandoned']);
  });
});
