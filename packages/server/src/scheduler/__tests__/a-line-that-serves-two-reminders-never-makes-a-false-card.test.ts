// One line serves two reminders that fired together ("Time to call the shop, and stand up and stretch."), written in
// the shop run's turn and cited by the stretch reminder's hand-in. Both runs count it as delivered, and the free check
// (the small local model) judges each: a yes decides both with no manager and no card; a no sends each to its decider
// once, and a second hand-in of the same run on the same line is refused, so nothing is reviewed again.
import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';

vi.mock('../../gateway/ws.js', () => ({ broadcast: () => {}, stampPersistedRow: (e: unknown) => e }));
vi.mock('../../agent/v2/loop.js', () => ({ runV2Turn: async () => {} }));
const box = await import('./helpers/reminders-box.js');
const { at, db, turn, line, reminder, openRun, runState, handIn, ghosts, checkScheduledTasks, closeRunsThatDelivered, freeCheckSays, decidedBy } = box;
const { decide } = await import('../../work/done/decide.js');

beforeAll(() => box.openBox());
afterAll(() => box.closeBox());
afterEach(() => freeCheckSays(null));

/** The shop and stretch reminders fire at 07:54 on `day`; the shop run's turn writes one line for both. */
async function oneLineForBoth(day: string): Promise<{ shop: string; stretch: string; both: string }> {
  at(`${day}T07:30:00Z`);
  const shop = await reminder('Shop call', `${day}T07:54:00Z`);
  const stretch = await reminder('Stretch reminder', `${day}T07:54:00Z`);
  at(`${day}T07:54:25Z`);
  await checkScheduledTasks();
  let both = '';
  await turn({ kind: 'occurrence', id: openRun(shop) }, async () => {
    both = line('Time to call the shop, and stand up and stretch.', 'imessage');
    const r = await handIn(stretch, both); expect(r.isError, r.content).toBe(false);
  });
  await closeRunsThatDelivered();
  await new Promise((r) => setTimeout(r, 50));
  return { shop, stretch, both };
}
const taskState = (id: string): string => (db().prepare('SELECT state FROM work WHERE id = ?').get(id) as { state: string }).state;

describe('a line that serves two reminders never makes a false card', () => {
  it('the free check says yes: both runs are delivered on it and decided by the engine, no manager, no card', async () => {
    freeCheckSays(true);
    const { shop, stretch, both } = await oneLineForBoth('2026-03-02');
    expect([runState(shop), runState(stretch)]).toEqual([{ state: 'done', result_delivery_id: both }, { state: 'done', result_delivery_id: both }]);
    expect([decidedBy(shop), decidedBy(stretch)]).toEqual(['engine', 'engine']);
    expect([taskState(shop), taskState(stretch)]).toEqual(['done', 'done']);
    expect(ghosts()).toBe(0);
  });

  it('the free check says no: each waits for its decider once, and the same line cannot be handed in for it again', async () => {
    freeCheckSays(false);
    const { shop, stretch, both } = await oneLineForBoth('2026-03-03');
    expect([runState(shop).state, runState(stretch).state]).toEqual(['done', 'done']);
    expect([taskState(shop), taskState(stretch)], 'each waits for its decider').toEqual(['handed_in', 'handed_in']);
    expect([decidedBy(shop), decidedBy(stretch)]).toEqual([null, null]);
    for (const task of [shop, stretch]) {
      expect(decide({ workId: task, deciderAgentId: null, verdict: 'send_back', reason: 'that line was not the reminder' }).kind).toBe('decided');
      const again = await handIn(task, both);
      expect(again.isError).toBe(true);
      expect(again.content).toContain('already judged for this run');
      expect(taskState(task), 'nothing is handed in to be reviewed again').not.toBe('handed_in');
    }
    expect(ghosts()).toBe(0);
  });
});
