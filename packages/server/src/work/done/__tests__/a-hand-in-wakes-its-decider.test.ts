// "So and so says they got this done": a hand-in wakes the decider with the row, every time, and a
// doorbell handler that fails never undoes the hand-in it rode in on.
import { describe, it, expect, vi, afterEach } from 'vitest';

vi.mock('../../../db/connection.js', async () => (await import('./helpers/done-db.js')).connectionMock());
vi.mock('../../../gateway/ws.js', () => ({ broadcast: () => {}, stampPersistedRow: (e: unknown) => e }));
vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 });

import { setValidationDoorbellHandler, type DoorbellRing } from '../../validation-drive.js';
import { handIn } from '../hand-in.js';
import { freshBoard, deliveredToOwner, stateOf, WORKER, TASK } from './helpers/decision-world.js';
import { doneDb } from './helpers/done-db.js';

const by = { kind: 'worker' as const, agentId: WORKER };
afterEach(() => setValidationDoorbellHandler(null));

function anotherTask(id: string): void {
  const at = Date.now() - 60_000;
  doneDb().prepare(
    `INSERT INTO work (id, kind, agent_id, requester, root_kind, root_id, state, intent, wakes, closes_thread, title, opened_at, updated_at)
     VALUES (?, 'task', ?, 'owner', 'tracker', ?, 'claimed', 'task', 1, 0, 'Another report', ?, ?)`,
  ).run(id, WORKER, id, at, at);
}

describe('a hand-in wakes its decider', () => {
  it("the worker's hand-in rings the doorbell carrying that row", () => {
    freshBoard();
    const rings: DoorbellRing[] = [];
    setValidationDoorbellHandler((r) => { rings.push(r); });
    expect(handIn({ workId: TASK, by, outcome: 'finished', items: [{ kind: 'delivery', ref: deliveredToOwner() }], note: 'Report sent' }).kind).toBe('handed_in');
    expect(rings).toEqual([{ workId: TASK, shape: 'close-request' }]);
  });

  it('a handler that THROWS cannot undo the hand-in it rode in on', () => {
    freshBoard();
    setValidationDoorbellHandler(() => { throw new Error('PM is on fire'); });
    expect(handIn({ workId: TASK, by, outcome: 'finished', items: [{ kind: 'delivery', ref: deliveredToOwner() }], note: 'Report sent' }).kind).toBe('handed_in');
    expect(stateOf()).toBe('handed_in');
  });

  it('A BURST OF 20 HAND-INS RINGS 20 TIMES: nothing throttles the doorbell', () => {
    freshBoard();
    const rings: DoorbellRing[] = [];
    setValidationDoorbellHandler((r) => { rings.push(r); });
    for (let i = 0; i < 20; i++) {
      anotherTask(`burst-${i}`);
      expect(handIn({ workId: `burst-${i}`, by, outcome: 'finished', items: [{ kind: 'delivery', ref: deliveredToOwner() }], note: 'Report sent' }).kind).toBe('handed_in');
    }
    expect(new Set(rings.map((r) => r.workId)).size).toBe(20);
  });
});
