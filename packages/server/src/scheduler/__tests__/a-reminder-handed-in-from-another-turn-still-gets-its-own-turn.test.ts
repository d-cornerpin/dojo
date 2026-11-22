// The lived round-three shop reminder: the owner texted for it, it fires while the agent is in a dashboard turn about
// another task, and that turn writes the reminder there and hands it in on that line. A dashboard line does not reach an
// owner who asked by text: the hand-in is refused and the run stays open. The next turn the serve boundary picks is the
// run's own, rooted on the run, and its text closes the run: one message on his phone, no card, no second dashboard
// copy. Pausing the schedule still retires the prompt.
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';

vi.mock('../../gateway/ws.js', () => ({ broadcast: () => {}, stampPersistedRow: (e: unknown) => e }));
vi.mock('../../agent/v2/loop.js', () => ({ runV2Turn: async () => {} }));
const box = await import('./helpers/reminders-box.js');
const { at, call, db, turn, line, reminder, openRun, runState, handIn, checkScheduledTasks, closeRunsThatDelivered, ghosts, freeCheckSays, decidedBy, MAIN } = box;
const { getPendingEngineEvent } = await import('../../agent/v2/counterparty.js');
const { engineEventRoot } = await import('../../agent/v2/work-lineage.js');

beforeAll(() => box.openBox());
afterAll(() => box.closeBox());

/** The shop reminder fires during a dashboard turn about another task, which writes it there and hands it in on that line. */
async function handedInFromAnotherTurn(day: string): Promise<string> {
  at(`${day}T07:38:00Z`);
  const shop = await reminder('Shop call', `${day}T07:53:00Z`);
  db().prepare(`INSERT INTO messages (id, agent_id, lane, role, content, origin_intent, authorized, served_by_turn, created_at)
    VALUES (?, ?, 'events', 'user', '[Engine hint: step two is waiting]', 'engine_hint', 0, 1, ?)`).run(`hint-${day}`, MAIN, Date.now());
  at(`${day}T07:53:25Z`);
  await turn({ kind: 'engine', id: `hint-${day}` }, async () => {
    await checkScheduledTasks();
    const r = await handIn(shop, line('Time to call the shop.', 'dashboard'));
    expect(r.content).toContain('reached him only on the dashboard, but he asked by imessage');
  });
  await closeRunsThatDelivered();
  expect(runState(shop).state, 'the dashboard line settles nothing owed by text').toBe('open');
  return shop;
}

const sent = (channel: string): number => (db().prepare('SELECT COUNT(*) AS n FROM deliveries WHERE channel = ?').get(channel) as { n: number }).n;

describe('a reminder handed in from another turn still gets its own turn', () => {
  it('the next engine event served is the run\'s own prompt, rooted on the run, and its text closes the run', async () => {
    freeCheckSays(true);
    const lines = sent('dashboard');
    const shop = await handedInFromAnotherTurn('2026-03-02');
    const texts = sent('imessage');
    const next = getPendingEngineEvent(MAIN);
    expect(next?.runId).toBe(openRun(shop));
    const root = engineEventRoot(next!);
    expect(root).toMatchObject({ kind: 'occurrence', id: openRun(shop) });
    let text = '';
    await turn({ kind: 'occurrence', id: root.id }, () => { text = line('Shop o\'clock: time to call them.', 'imessage'); });
    await closeRunsThatDelivered();
    expect(runState(shop)).toEqual({ state: 'done', result_delivery_id: text });
    await new Promise((r) => setTimeout(r, 50));
    expect([sent('imessage') - texts, sent('dashboard') - lines, ghosts(), decidedBy(shop)]).toEqual([1, 1, 0, 'engine']);
    freeCheckSays(null);
  });

  it('a paused schedule still retires the run\'s prompt', async () => {
    const shop = await handedInFromAnotherTurn('2026-03-03');
    const paused = await call('work_schedule', { action: 'pause', task_id: shop });
    expect(paused.isError, paused.content).toBeFalsy();
    expect(getPendingEngineEvent(MAIN)?.runId).not.toBe(openRun(shop));
  });
});
