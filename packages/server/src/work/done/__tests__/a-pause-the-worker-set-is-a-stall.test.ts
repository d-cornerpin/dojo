// A pause the worker set on its own task is a stall: its worker is hinted with the reason, then the PM is told,
// then the owner's card says what the task is waiting on.
import { describe, it, expect, vi } from 'vitest';

vi.mock('../../../db/connection.js', async () => (await import('./helpers/done-db.js')).connectionMock());
vi.mock('../../../gateway/ws.js', async () => (await import('./helpers/ladder-world.js')).wsMock());
vi.mock('../../../agent/runtime.js', async () => (await import('./helpers/ladder-world.js')).runtimeMock());
vi.mock('../../../tracker/pm-agent.js', async (orig) => ({ ...(await orig<object>()), armDebouncedReview: vi.fn() }));
vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 });

import { runLadder, LADDER_ENTRY } from '../ladder.js';
import { freshBoard, call, WORKER, TASK } from './helpers/decision-world.js';
import { hintsTo, cards, entries, resetLadderWorld, anchorBack, MIN } from './helpers/ladder-world.js';

const REASON = 'waiting for the vendor to send the tracking number';

describe('a pause the worker set is a stall', () => {
  it('hint with the reason, then the PM, then the owner\'s card naming what it waits on', async () => {
    freshBoard(); anchorBack(2 * 60 * MIN); resetLadderWorld();
    expect((await call(WORKER, 'work_update', { action: 'status', task_id: TASK, status: 'paused', notes: REASON })).isError).toBe(false);
    await runLadder(Date.now() + 6 * MIN);
    expect(hintsTo(WORKER)).toHaveLength(1);
    expect(hintsTo(WORKER)[0]).toContain(`held paused since`);
    expect(hintsTo(WORKER)[0]).toContain(REASON);
    await runLadder(Date.now() + 12 * MIN);
    expect(entries(TASK, LADDER_ENTRY.pm)).toBe(1);
    await runLadder(Date.now() + 18 * MIN);
    const card = cards.filter((c) => c.cardKey === `stall:${TASK}`);
    expect(card).toHaveLength(1);
    expect(card[0].error).toContain(`has been paused since`);
    expect(card[0].error).toContain(`waiting on: ${REASON}`);
  });
});
