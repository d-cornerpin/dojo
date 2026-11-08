// A handed-in task never sits in silence: when the PM cannot review it (no model, or gone), each review the
// ladder rings is a review with no verdict, and after two the main agent is woken to decide it.
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../../db/connection.js', async () => (await import('./helpers/done-db.js')).connectionMock());
vi.mock('../../../gateway/ws.js', async () => (await import('./helpers/ladder-world.js')).wsMock());
vi.mock('../../../agent/runtime.js', async () => (await import('./helpers/ladder-world.js')).runtimeMock());
const { wake } = vi.hoisted(() => ({ wake: vi.fn() }));
vi.mock('../../../tracker/pm-agent.js', async (orig) => ({ ...(await orig<object>()), armDebouncedReview: wake }));
vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 });

import { runLadder } from '../ladder.js';
import { whoDecides } from '../who-decides.js';
import { runPMReview } from '../../../tracker/pm-agent.js';
import { freshBoard, handedIn, MAIN, PM, TASK } from './helpers/decision-world.js';
import { hintsTo, resetLadderWorld, MIN } from './helpers/ladder-world.js';
import { doneDb } from './helpers/done-db.js';

beforeEach(() => { resetLadderWorld(); wake.mockReset(); });

describe('a handed-in task never sits in silence', () => {
  it('with the PM gone, the ladder rings its review each bound, and after two the main agent decides', async () => {
    freshBoard();
    doneDb().prepare("UPDATE agents SET status = 'terminated' WHERE id = ?").run(PM);
    await handedIn();
    await runLadder(Date.now() + 6 * MIN);
    expect(wake).toHaveBeenCalledWith(TASK, 'ladder');
    await runPMReview();
    await runPMReview();
    expect(whoDecides(TASK)).toEqual({ kind: 'agent', agentId: MAIN });
    await runLadder(Date.now() + 6 * MIN);
    expect(hintsTo(MAIN)).toHaveLength(1);
  });
});
