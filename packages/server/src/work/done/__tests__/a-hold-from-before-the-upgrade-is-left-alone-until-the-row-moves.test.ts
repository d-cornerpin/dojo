// A hold already on a row at the upgrade is left alone by the ladder until the row next moves; then it is
// clocked like any other row.
import { describe, it, expect, vi } from 'vitest';

vi.mock('../../../db/connection.js', async () => (await import('./helpers/done-db.js')).connectionMock());
vi.mock('../../../gateway/ws.js', async () => (await import('./helpers/ladder-world.js')).wsMock());
vi.mock('../../../agent/runtime.js', async () => (await import('./helpers/ladder-world.js')).runtimeMock());
vi.mock('../../../tracker/pm-agent.js', async (orig) => ({ ...(await orig<object>()), armDebouncedReview: vi.fn() }));
vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 });

import { runLadder } from '../ladder.js';
import { clearHold } from '../hold.js';
import { freshBoard, WORKER, TASK } from './helpers/decision-world.js';
import { hintsTo, cards, resetLadderWorld, MIN } from './helpers/ladder-world.js';
import { doneDb } from './helpers/done-db.js';

const DAY = 24 * 60 * MIN;

describe('a hold from before the upgrade is left alone until the row moves', () => {
  it('a mapped blocked row is never hinted; once its hold lifts it is', async () => {
    freshBoard(); resetLadderWorld();
    const before = Date.now() - 2 * DAY;
    doneDb().prepare("UPDATE work SET updated_at = ?, hold_kind = 'blocked', hold_reason = 'waiting for the landlord', hold_at = ? WHERE id = ?").run(before, before, TASK);
    for (const at of [6, 12, 90, 24 * 60]) await runLadder(Date.now() + at * MIN);
    expect(hintsTo(WORKER)).toEqual([]);
    expect(cards).toEqual([]);
    expect(clearHold(TASK, WORKER)).toBe(true);
    await runLadder(Date.now() + 6 * MIN);
    expect(hintsTo(WORKER)).toHaveLength(1);
  });
});
