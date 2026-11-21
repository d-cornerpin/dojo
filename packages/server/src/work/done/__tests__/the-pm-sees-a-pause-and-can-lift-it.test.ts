// The PM's report says a stalled task is paused, by whom, why and until when; if the wait is not real, its retask
// to the worker lifts the pause.
import { describe, it, expect, vi } from 'vitest';

vi.mock('../../../db/connection.js', async () => (await import('./helpers/done-db.js')).connectionMock());
vi.mock('../../../gateway/ws.js', async () => (await import('./helpers/ladder-world.js')).wsMock());
vi.mock('../../../agent/runtime.js', async () => (await import('./helpers/ladder-world.js')).runtimeMock());
vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 });

import { runLadder } from '../ladder.js';
import { holdOf } from '../hold.js';
import { runPMReview } from '../../../tracker/pm-agent.js';
import { freshBoard, call, PM, WORKER, TASK } from './helpers/decision-world.js';
import { lastReport, pmCanRun, resetLadderWorld, turnTaken, MIN } from './helpers/ladder-world.js';

describe('the PM sees a pause and can lift it', () => {
  it('the report names the pause; a retask lifts it', async () => {
    freshBoard(); pmCanRun(PM); resetLadderWorld();
    await call(WORKER, 'work_update', { action: 'status', task_id: TASK, status: 'paused', notes: 'waiting for the owner to pick a colour', resume_at: '2099-01-01T09:00:00Z' });
    await runLadder(Date.now() + 6 * MIN);
    turnTaken(WORKER);
    await runLadder(Date.now() + 12 * MIN);
    await runPMReview();
    expect(lastReport(PM)).toContain('It is held: paused by its worker, waiting on: waiting for the owner to pick a colour, until 2099-01-01 09:00 UTC.');
    const r = await call(PM, 'work_validate', { action: 'retask', task_id: TASK, directive: 'The owner already chose blue in chat this morning; go on with blue.' });
    expect(r.isError, r.content).toBe(false);
    expect(holdOf(TASK)).toBeNull();
  });
});
