// A reminder is handed in during a turn about another task, and its worker goes straight on to other turns that do
// not serve it. The run waits only for the turn that served it: once that turn ends, the reaper closes the run on its
// line though the worker is still busy. Turns an older version left open, of the worker or of another agent, are
// ended at the first start after the update and hold nothing, and so does a row a running process left open: only the
// turn the worker is running now holds its run.
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';

vi.mock('../../gateway/ws.js', () => ({ broadcast: () => {}, stampPersistedRow: (e: unknown) => e }));
vi.mock('../../agent/v2/loop.js', () => ({ runV2Turn: async () => {} }));
const box = await import('./helpers/reminders-box.js');
const { at, db, turn, line, reminder, runState, handIn, ghosts, checkScheduledTasks, closeRunsThatDelivered, otherTasksHint, MAIN } = box;
const { resetWorkingAgentsToIdleAtBoot } = await import('../../agent/agent-status.js');

beforeAll(() => box.openBox());
afterAll(() => box.closeBox());

describe('a run closes while its worker keeps busy', () => {
  it('the worker runs back-to-back turns that do not serve the run: the run closes on its line', async () => {
    at('2026-03-02T07:38:00Z');
    db().prepare("INSERT INTO agents (id, name, status, config, classification) VALUES ('agent-other', 'other', 'idle', '{}', 'apprentice')").run();
    db().prepare("INSERT INTO turns (agent_id, turn_number, started_at, answered) VALUES ('agent-other', 1, '2025-12-01 09:00:00', 0)").run();
    db().prepare("INSERT INTO turns (agent_id, turn_number, started_at, answered) VALUES (?, 9000, '2025-12-01 09:00:00', 0)").run(MAIN);
    resetWorkingAgentsToIdleAtBoot();   // the first start after the update
    const shop = await reminder('Shop call', '2026-03-02T07:53:00Z');
    const stepTwo = await otherTasksHint('busy');
    at('2026-03-02T07:53:25Z');
    let shopLine = '';
    await turn(stepTwo, async () => {
      await checkScheduledTasks();
      shopLine = line('Time to call the shop.', 'dashboard');
      expect((await handIn(shop, shopLine)).isError).toBe(false);
    });
    at('2026-03-02T07:53:40Z');
    await turn(await otherTasksHint('busy-2'), async () => {
      line('Step two is done.', 'dashboard');
      await closeRunsThatDelivered();
    });
    expect(runState(shop)).toEqual({ state: 'done', result_delivery_id: shopLine });
    expect(ghosts()).toBe(0);
  });

  it('the turn that handed the run in stopped running with its row still open: the run closes on its line', async () => {
    at('2026-03-03T07:38:00Z');
    const shop = await reminder('Shop call', '2026-03-03T07:53:00Z');
    at('2026-03-03T07:53:25Z');
    let shopLine = '';
    await turn(await otherTasksHint('leaked'), async () => {
      await checkScheduledTasks();
      shopLine = line('Time to call the shop.', 'dashboard');
      expect((await handIn(shop, shopLine)).isError).toBe(false);
    }, false);
    await closeRunsThatDelivered();
    expect(runState(shop)).toEqual({ state: 'done', result_delivery_id: shopLine });
  });
});
