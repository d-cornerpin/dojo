// A reminder the owner texted for fires while the agent is in a turn about another task, and that turn hands the
// reminder in on its dashboard line. The run's own prompt is not spent by that hand-in: the next turn the serve
// boundary picks is the run's own, rooted on the run, and its text to the owner closes the run. Pausing the
// schedule still retires the prompt.
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';

vi.mock('../../gateway/ws.js', () => ({ broadcast: () => {}, stampPersistedRow: (e: unknown) => e }));
vi.mock('../../agent/v2/loop.js', () => ({ runV2Turn: async () => {} }));
const box = await import('./helpers/reminders-box.js');
const { at, call, db, turn, line, reminder, openRun, runState, handIn, checkScheduledTasks, closeRunsThatDelivered, MAIN } = box;
const { getPendingEngineEvent } = await import('../../agent/v2/counterparty.js');
const { engineEventRoot } = await import('../../agent/v2/work-lineage.js');

beforeAll(() => box.openBox());
afterAll(() => box.closeBox());

/** The shop reminder fires during a turn about another task, which hands the reminder in on its dashboard line. */
async function handedInFromAnotherTurn(day: string): Promise<string> {
  at(`${day}T07:38:00Z`);
  const shop = await reminder('Shop call', `${day}T07:53:00Z`);
  db().prepare(`INSERT INTO messages (id, agent_id, lane, role, content, origin_intent, authorized, served_by_turn, created_at)
    VALUES (?, ?, 'events', 'user', '[Engine hint: step two is waiting]', 'engine_hint', 0, 1, ?)`).run(`hint-${day}`, MAIN, Date.now());
  at(`${day}T07:53:25Z`);
  await turn({ kind: 'engine', id: `hint-${day}` }, async () => {
    await checkScheduledTasks();
    const r = await handIn(shop, line('Time to call the shop.', 'dashboard'));
    expect(r.isError, r.content).toBe(false);
  });
  return shop;
}

describe('a reminder handed in from another turn still gets its own turn', () => {
  it('the next engine event served is the run\'s own prompt, rooted on the run, and its text closes the run', async () => {
    const shop = await handedInFromAnotherTurn('2026-03-02');
    const next = getPendingEngineEvent(MAIN);
    expect(next?.runId).toBe(openRun(shop));
    const root = engineEventRoot(next!);
    expect(root).toMatchObject({ kind: 'occurrence', id: openRun(shop) });
    let text = '';
    await turn({ kind: 'occurrence', id: root.id }, () => { text = line('Shop o\'clock: time to call them.', 'imessage'); });
    await closeRunsThatDelivered();
    expect(runState(shop)).toEqual({ state: 'done', result_delivery_id: text });
  });

  it('a paused schedule still retires the run\'s prompt', async () => {
    const shop = await handedInFromAnotherTurn('2026-03-03');
    const paused = await call('work_schedule', { action: 'pause', task_id: shop });
    expect(paused.isError, paused.content).toBeFalsy();
    expect(getPendingEngineEvent(MAIN)?.runId).not.toBe(openRun(shop));
  });
});
