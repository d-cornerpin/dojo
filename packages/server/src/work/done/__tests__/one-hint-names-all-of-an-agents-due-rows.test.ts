// An agent with several stalled rows gets one hint a sweep naming all of them; each row records it in plain words.
import { describe, it, expect, vi } from 'vitest';

vi.mock('../../../db/connection.js', async () => (await import('./helpers/done-db.js')).connectionMock());
vi.mock('../../../gateway/ws.js', async () => (await import('./helpers/ladder-world.js')).wsMock());
vi.mock('../../../agent/runtime.js', async () => (await import('./helpers/ladder-world.js')).runtimeMock());
vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 });

import { runLadder, LADDER_ENTRY } from '../ladder.js';
import { freshBoard, WORKER, TASK } from './helpers/decision-world.js';
import { hintsTo, entries, resetLadderWorld, workingTask, MIN } from './helpers/ladder-world.js';
import { listTaskLog } from '../../../tracker/task-log.js';

describe('one hint names all of an agent\'s due rows', () => {
  it('two stalled rows of one worker: one hint naming both, one entry on each', async () => {
    freshBoard(); resetLadderWorld();
    const second = workingTask('task-second', WORKER, 'Sort the photos');
    await runLadder(Date.now() + 6 * MIN);
    expect(hintsTo(WORKER)).toHaveLength(1);
    expect(hintsTo(WORKER)[0]).toContain(`"Write the report" has not moved since`);
    expect(hintsTo(WORKER)[0]).toContain(`"Sort the photos" has not moved since`);
    expect([entries(TASK, LADDER_ENTRY.hint), entries(second, LADDER_ENTRY.hint)]).toEqual([1, 1]);
    for (const id of [TASK, second]) expect(listTaskLog(id).find((e) => e.entryKind === LADDER_ENTRY.hint)).toMatchObject({ reason: 'Reminded the worker.', actionTaken: null });
  });
});
