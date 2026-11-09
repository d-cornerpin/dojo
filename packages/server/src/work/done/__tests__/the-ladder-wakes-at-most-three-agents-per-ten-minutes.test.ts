// The box takes at most three ladder wakes per ten minutes; the rest wait for the next window.
import { describe, it, expect, vi } from 'vitest';

vi.mock('../../../db/connection.js', async () => (await import('./helpers/done-db.js')).connectionMock());
vi.mock('../../../gateway/ws.js', async () => (await import('./helpers/ladder-world.js')).wsMock());
vi.mock('../../../agent/runtime.js', async () => (await import('./helpers/ladder-world.js')).runtimeMock());
vi.mock('../../../tracker/pm-agent.js', async (orig) => ({ ...(await orig<object>()), armDebouncedReview: vi.fn() }));
vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 });

import { runLadder } from '../ladder.js';
import { FXID } from '../../../../../../deploy/checks/fixture-vocabulary.mjs';
import { freshBoard, MAIN, WORKER, OTHER } from './helpers/decision-world.js';
import { hintsTo, resetLadderWorld, workingTask, MIN } from './helpers/ladder-world.js';
import { doneDb } from './helpers/done-db.js';

const FOURTH = FXID.n5;

describe('the ladder wakes at most three agents per ten minutes', () => {
  it('five due rows across four agents: three wakes now, the fourth in the next window', async () => {
    freshBoard(); resetLadderWorld();
    doneDb().prepare("INSERT INTO agents (id, name, status, classification) VALUES (?, ?, 'idle', 'standard')").run(FOURTH, FOURTH);
    workingTask('task-other', OTHER, 'Book the venue');
    workingTask('task-main', MAIN, 'Plan the trip');
    workingTask('task-fourth', FOURTH, 'File the receipts');
    workingTask('task-worker-2', WORKER, 'Sort the photos');
    const woken = (): number => [WORKER, OTHER, MAIN, FOURTH].filter((a) => hintsTo(a).length > 0).length;
    await runLadder(Date.now() + 6 * MIN);
    expect(woken()).toBe(3);
    await runLadder(Date.now() + 8 * MIN);
    expect(woken()).toBe(3);
    await runLadder(Date.now() + 17 * MIN);
    expect(woken()).toBe(4);
  });
});
