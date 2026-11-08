// The ladder leaves alone: an owner-paused task (its clock restarts when the pause lifts), a row whose
// worker no longer exists, a Working row already idle 14 days when the box first ran the ladder (and a
// younger idle row's clock starts at that first run, never at its old date), a worker in a live turn, and
// a row decided between two sweeps.
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../../db/connection.js', async () => (await import('./helpers/done-db.js')).connectionMock());
vi.mock('../../../gateway/ws.js', async () => (await import('./helpers/ladder-world.js')).wsMock());
vi.mock('../../../agent/runtime.js', async () => (await import('./helpers/ladder-world.js')).runtimeMock());
vi.mock('../../../tracker/pm-agent.js', async (orig) => ({ ...(await orig<object>()), armDebouncedReview: vi.fn() }));
vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 });

import { runLadder } from '../ladder.js';
import { setHold, clearHold } from '../hold.js';
import { decide } from '../decide.js';
import { activeRuns } from '../../../agent/shared-state.js';
import { freshBoard, handedIn, stateOf, MAIN, WORKER, TASK } from './helpers/decision-world.js';
import { hintsTo, cards, entries, resetLadderWorld, MIN } from './helpers/ladder-world.js';
import { LADDER_ENTRY } from '../ladder.js';
import { doneDb } from './helpers/done-db.js';

const DAY = 24 * 60 * MIN;
beforeEach(() => { freshBoard(); resetLadderWorld(); activeRuns.delete(WORKER); });

describe('the ladder leaves some work alone', () => {
  it('an owner-paused task gets no hint, and its clock starts again when the pause lifts', async () => {
    expect(setHold(TASK, 'paused', 'the owner wants to read it first', 'user').ok).toBe(true);
    await runLadder(Date.now() + 60 * MIN);
    expect(hintsTo(WORKER)).toEqual([]);
    doneDb().prepare('UPDATE work SET updated_at = updated_at - ? WHERE id = ?').run(DAY, TASK);
    expect(clearHold(TASK, 'user')).toBe(true);
    await runLadder(Date.now() + 2 * MIN);
    expect(hintsTo(WORKER)).toEqual([]);
    await runLadder(Date.now() + 6 * MIN);
    expect(hintsTo(WORKER)).toHaveLength(1);
  });

  it('a row whose worker no longer exists is never touched', async () => {
    doneDb().prepare("UPDATE agents SET status = 'terminated' WHERE id = ?").run(WORKER);
    await runLadder(Date.now() + 60 * MIN);
    expect(hintsTo(WORKER)).toEqual([]);
    expect(cards).toEqual([]);
  });

  it('a Working row idle 14 days when the ladder first ran stays quiet', async () => {
    doneDb().prepare('UPDATE work SET updated_at = ?, opened_at = ? WHERE id = ?').run(Date.now() - 15 * DAY, Date.now() - 15 * DAY, TASK);
    await runLadder(Date.now() + 60 * MIN);
    expect(hintsTo(WORKER)).toEqual([]);
  });

  it('a worker in a live turn gets its hint on a later sweep, not now', async () => {
    activeRuns.add(WORKER);
    await runLadder(Date.now() + 6 * MIN);
    expect(hintsTo(WORKER)).toEqual([]);
    activeRuns.delete(WORKER);
    await runLadder(Date.now() + 6 * MIN);
    expect(hintsTo(WORKER)).toHaveLength(1);
  });

  it('a row decided between sweeps is left alone', async () => {
    await handedIn();
    expect(decide({ workId: TASK, deciderAgentId: null, verdict: 'cancel', reason: 'The owner no longer needs it' }).kind).toBe('decided');
    expect(stateOf()).toBe('abandoned');
    await runLadder(Date.now() + DAY);
    expect(hintsTo(WORKER)).toEqual([]);
    expect(hintsTo(MAIN)).toEqual([]);
    expect(cards).toEqual([]);
  });

  it('rows idle 1 to 13 days when the ladder first ran are clocked from that run: no hint, mark or card at once, the hint one bound later', async () => {
    const ids = [1, 5, 13].map((d) => {
      const id = `task-idle-${d}d`;
      doneDb().prepare(
        `INSERT INTO work (id, kind, agent_id, requester, root_kind, root_id, state, intent, wakes, closes_thread, title, opened_at, updated_at)
         VALUES (?, 'task', ?, 'owner', 'tracker', ?, 'claimed', 'task', 1, 0, 'An older job', ?, ?)`,
      ).run(id, WORKER, id, Date.now() - d * DAY, Date.now() - d * DAY);
      return id;
    });
    await runLadder(Date.now());
    await runLadder(Date.now() + 2 * MIN);
    expect(hintsTo(WORKER)).toEqual([]);
    expect(ids.map((id) => entries(id, LADDER_ENTRY.pm))).toEqual([0, 0, 0]);
    expect(cards).toEqual([]);
    await runLadder(Date.now() + 6 * MIN);
    expect(hintsTo(WORKER).filter((h) => h.includes('An older job'))).toHaveLength(3);
  });
});
