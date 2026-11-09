// While a person is waiting on an agent, the ladder does not wake it; the step is taken on a later sweep.
import { describe, it, expect, vi } from 'vitest';

vi.mock('../../../db/connection.js', async () => (await import('./helpers/done-db.js')).connectionMock());
vi.mock('../../../gateway/ws.js', async () => (await import('./helpers/ladder-world.js')).wsMock());
vi.mock('../../../agent/runtime.js', async () => (await import('./helpers/ladder-world.js')).runtimeMock());
vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 });

import { runLadder } from '../ladder.js';
import { freshBoard, WORKER } from './helpers/decision-world.js';
import { hintsTo, resetLadderWorld, MIN } from './helpers/ladder-world.js';
import { doneDb } from './helpers/done-db.js';

describe('the ladder stands down while a person waits', () => {
  it('no hint while the worker owes a person an answer; the hint once it is answered', async () => {
    freshBoard(); resetLadderWorld();
    doneDb().prepare(
      `INSERT INTO work (id, kind, agent_id, requester, root_kind, root_id, state, intent, wakes, closes_thread, opened_at, updated_at)
       VALUES ('ask-waiting', 'ask', ?, 'owner', 'message', 'ask-waiting', 'open', 'question', 1, 1, ?, ?)`,
    ).run(WORKER, Date.now(), Date.now());
    await runLadder(Date.now() + 6 * MIN);
    expect(hintsTo(WORKER)).toEqual([]);
    doneDb().prepare("UPDATE work SET state = 'claimed' WHERE id = 'ask-waiting'").run();
    await runLadder(Date.now() + 6 * MIN);
    expect(hintsTo(WORKER)).toHaveLength(1);
  });
});
