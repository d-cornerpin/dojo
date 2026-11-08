// "So and so says they got this done": every hand-in wakes the PM's review with the row, a burst of them
// wakes it for each, and a wake that fails never undoes the hand-in it rode in on.
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../../db/connection.js', async () => (await import('./helpers/done-db.js')).connectionMock());
vi.mock('../../../gateway/ws.js', () => ({ broadcast: () => {}, stampPersistedRow: (e: unknown) => e }));
const { wake } = vi.hoisted(() => ({ wake: vi.fn() }));
vi.mock('../../../tracker/pm-agent.js', async (orig) => ({ ...(await orig<object>()), armDebouncedReview: wake }));
vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 });

import { handIn } from '../hand-in.js';
import { freshBoard, deliveredToOwner, stateOf, WORKER, TASK } from './helpers/decision-world.js';
import { doneDb } from './helpers/done-db.js';

const by = { kind: 'worker' as const, agentId: WORKER };
const woken = (): string[] => wake.mock.calls.map(([id]) => id);
beforeEach(() => { freshBoard(); wake.mockReset(); });

function anotherTask(id: string): void {
  const at = Date.now() - 60_000;
  doneDb().prepare(
    `INSERT INTO work (id, kind, agent_id, requester, root_kind, root_id, state, intent, wakes, closes_thread, title, opened_at, updated_at)
     VALUES (?, 'task', ?, 'owner', 'tracker', ?, 'claimed', 'task', 1, 0, 'Another report', ?, ?)`,
  ).run(id, WORKER, id, at, at);
}

describe('a hand-in wakes its decider', () => {
  it("the worker's hand-in wakes the PM's review carrying that row", async () => {
    expect(handIn({ workId: TASK, by, outcome: 'finished', items: [{ kind: 'delivery', ref: deliveredToOwner() }], note: 'Report sent' }).kind).toBe('handed_in');
    await vi.waitFor(() => expect(woken()).toEqual([TASK]), { timeout: 30_000 });
  });

  it('a wake that THROWS cannot undo the hand-in it rode in on', async () => {
    wake.mockImplementation(() => { throw new Error('PM is on fire'); });
    expect(handIn({ workId: TASK, by, outcome: 'finished', items: [{ kind: 'delivery', ref: deliveredToOwner() }], note: 'Report sent' }).kind).toBe('handed_in');
    await vi.waitFor(() => expect(woken()).toEqual([TASK]), { timeout: 30_000 });
    expect(stateOf()).toBe('handed_in');
  });

  it('a burst of 20 hand-ins wakes the review for each: nothing throttles the wake', async () => {
    for (let i = 0; i < 20; i++) {
      anotherTask(`burst-${i}`);
      expect(handIn({ workId: `burst-${i}`, by, outcome: 'finished', items: [{ kind: 'delivery', ref: deliveredToOwner() }], note: 'Report sent' }).kind).toBe('handed_in');
    }
    await vi.waitFor(() => expect(new Set(woken()).size).toBe(20), { timeout: 30_000 });
  });
});
