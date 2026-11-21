// When the main agent keeps a delegated job as its own task, an owner's card on that task never ends the request:
// the main agent decides its own work. A helper's task carded the same way does end it.
import { describe, it, expect, vi } from 'vitest';

vi.mock('../../../db/connection.js', async () => (await import('./helpers/done-db.js')).connectionMock());
vi.mock('../../../gateway/ws.js', async () => (await import('./helpers/ladder-world.js')).wsMock());
vi.mock('../../../agent/runtime.js', async () => (await import('./helpers/ladder-world.js')).runtimeMock());
vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 });

import { recordValidationEscalation } from '../../tracker-store.js';
import { judgeKeptRequests } from '../../../agent/a2a-transport.js';
import { freshBoard, MAIN, WORKER, TASK } from './helpers/decision-world.js';
import { keptRequest, keptState, resetLadderWorld } from './helpers/ladder-world.js';

async function carded(worker: string): Promise<[string, string]> {
  freshBoard(worker); resetLadderWorld();
  const ask = await keptRequest(WORKER, TASK, MAIN);
  recordValidationEscalation(TASK, 'engine', null);
  await judgeKeptRequests(WORKER, 'thread-kept');
  return keptState(ask);
}

describe("the main agent's own kept work is never ended by the card", () => {
  it('its own task carded: the request stays open', async () => {
    expect(await carded(MAIN)).toEqual(['claimed', 'open']);
  });

  it("the helper's task carded: the request ends", async () => {
    expect(await carded(WORKER)).toEqual(['failed', 'abandoned']);
  });
});
