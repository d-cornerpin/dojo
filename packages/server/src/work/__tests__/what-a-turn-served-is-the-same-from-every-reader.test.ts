// What a turn served is one set, read the same while the turn runs and after it ended. Two reminders fire
// together; the turn rooted on the shop run hands the shop reminder in on its line and opens a follow-up task.
// The set holds the run, its task (as root and as worked) and the new task; the stretch run it never touched is
// not in it, and another agent's turn of the same number is a different set.
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';

vi.mock('../../gateway/ws.js', () => ({ broadcast: () => {}, stampPersistedRow: (e: unknown) => e }));
vi.mock('../../agent/v2/loop.js', () => ({ runV2Turn: async () => {} }));
const box = await import('../../scheduler/__tests__/helpers/reminders-box.js');
const { at, call, db, turn, line, reminder, openRun, handIn, checkScheduledTasks, MAIN } = box;
const { servedBy } = await import('../task-turns.js');

beforeAll(() => box.openBox());
afterAll(() => box.closeBox());

const pairs = (agentId: string, n: number): string[] => servedBy(agentId, n).map((s) => `${s.how} ${s.id}`).sort();
const runningTurn = (): number => (db().prepare('SELECT MAX(turn_number) AS n FROM turns WHERE agent_id = ?').get(MAIN) as { n: number }).n;

describe('what a turn served is the same from every reader', () => {
  it('the shop run\'s turn: one set, live and ended', async () => {
    at('2026-03-04T07:38:00Z');
    const shop = await reminder('Shop call', '2026-03-04T07:53:00Z');
    const stretch = await reminder('Stand up and stretch', '2026-03-04T07:53:00Z');
    at('2026-03-04T07:53:10Z');
    await checkScheduledTasks();
    const shopRun = openRun(shop);
    let live: string[] = [];
    let followUp = '';
    const n = await turn({ kind: 'occurrence', id: shopRun }, async () => {
      const text = line('Time to call the shop.', 'imessage');
      at('2026-03-04T07:53:17Z');
      const r = await handIn(shop, text);
      expect(r.isError, r.content).toBe(false);
      const made = await call('work_open', { kind: 'task', title: 'Ask the shop about the part', goal: 'The owner knows when the part arrives' });
      followUp = /task_id=([\w-]+)/.exec(made.content)![1]!;
      live = pairs(MAIN, runningTurn());
    });
    expect(live).toEqual(expect.arrayContaining([`root ${shopRun}`, `run ${shopRun}`, `root ${shop}`, `worked ${shop}`, `opened ${followUp}`]));
    expect(live.some((p) => p.endsWith(openRun(stretch)) || p.endsWith(stretch)), 'the stretch reminder was not served').toBe(false);
    expect(pairs(MAIN, n)).toEqual(live);
    expect(pairs('another-agent', n), 'turn numbers are per agent').toEqual([]);
  });
});
