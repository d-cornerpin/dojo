// A one-time reminder the owner texted for fires during a turn about another task, which writes the reminder on the
// dashboard and hands it in on that line. The run waits while that turn is open, then closes on the line when it
// ends; the free check reads the line as the reminder and the engine decides it. No card, no manager.
import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';

vi.mock('../../gateway/ws.js', () => ({ broadcast: () => {}, stampPersistedRow: (e: unknown) => e }));
vi.mock('../../agent/v2/loop.js', () => ({ runV2Turn: async () => {} }));
const box = await import('./helpers/reminders-box.js');
const { at, turn, line, reminder, openRun, runState, handIn, ghosts, checkScheduledTasks, closeRunsThatDelivered, otherTasksHint, freeCheckSays, decidedBy } = box;

beforeAll(() => box.openBox());
afterAll(() => box.closeBox());
afterEach(() => freeCheckSays(null));

describe('a reminder handed in from another turn is settled when that turn ends', () => {
  it('the run stays open while the turn runs, then closes on its line and is decided by the free check', async () => {
    freeCheckSays(true);
    at('2026-03-02T07:38:00Z');
    const shop = await reminder('Shop call', '2026-03-02T07:53:00Z');
    const stepTwo = await otherTasksHint('2026-03-02');
    at('2026-03-02T07:53:25Z');
    let shopLine = '';
    let whileOpen = '';
    await turn(stepTwo, async () => {
      await checkScheduledTasks();
      shopLine = line('Time to call the shop.', 'dashboard');
      const r = await handIn(shop, shopLine); expect(r.isError, r.content).toBe(false);
      await closeRunsThatDelivered();
      whileOpen = runState(shop).state;
    });
    expect(whileOpen, 'the turn that served the run is still open').toBe('open');
    expect(openRun(shop)).toBeTruthy();
    await closeRunsThatDelivered();
    await new Promise((r) => setTimeout(r, 50));
    expect(runState(shop)).toEqual({ state: 'done', result_delivery_id: shopLine });
    expect(decidedBy(shop)).toBe('engine');
    expect(ghosts()).toBe(0);
  });
});
