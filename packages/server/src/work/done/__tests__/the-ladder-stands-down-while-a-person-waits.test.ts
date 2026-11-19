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
import { insertMessage } from '../../../memory/message-store.js';

describe('the ladder stands down while a person waits', () => {
  it('no hint while the worker owes a person an answer; the hint once it is answered', async () => {
    freshBoard(); resetLadderWorld();
    insertMessage({
      id: 'm-waiting', agentId: WORKER, role: 'user', content: 'is the report ready?', lane: 'owner', channel: 'dashboard',
      senderId: 'owner', authorized: true, inboundMeta: JSON.stringify({ channel: 'dashboard', relation: 'owner' }),
    } as never);
    await runLadder(Date.now() + 6 * MIN);
    expect(hintsTo(WORKER)).toEqual([]);
    doneDb().prepare("UPDATE work SET state = 'claimed' WHERE id = 'ask:m-waiting'").run();
    await runLadder(Date.now() + 6 * MIN);
    expect(hintsTo(WORKER)).toHaveLength(1);
  });
});
