// A reminder the owner texted for, whose request settled on the confirmation, fires while the agent is in a turn
// about something else: another task's engine event (as lived), another task's run, no root at all, or the owner's
// unrelated question on the dashboard. That turn's one line to the owner is the reminder, and a later hand-in citing
// it is accepted, never refused as "the start line of its turn": that turn did not take up the reminder's request.
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';

vi.mock('../../gateway/ws.js', () => ({ broadcast: () => {}, stampPersistedRow: (e: unknown) => e }));
vi.mock('../../agent/v2/loop.js', () => ({ runV2Turn: async () => {} }));
const box = await import('./helpers/reminders-box.js');
const { at, call, turn, line, reminder, openRun, handIn, checkScheduledTasks, otherTasksHint, ownerTexts } = box;

beforeAll(() => box.openBox());
afterAll(() => box.closeBox());

type Door = 'engine' | 'occurrence' | 'none' | 'question';
/** A root for a turn about something other than the reminder. */
async function otherRoot(kind: Door, day: string): Promise<box.Root> {
  if (kind === 'none') return null;
  if (kind === 'engine') return otherTasksHint(day);
  if (kind === 'question') return { kind: 'ask', id: ownerTexts('What is on my calendar tomorrow?') };
  const made = await call('work_open', { kind: 'task', title: `Step two ${day}`, goal: 'the second step', scheduled_start: `${day}T07:50:00Z`, allow_duplicate: true });
  const other = /task_id=([\w-]+)/.exec(made.content)![1]!;
  at(`${day}T07:50:10Z`);
  await checkScheduledTasks();
  return { kind, id: openRun(other) };
}

const doors: Array<[Door, string, string]> = [
  ['engine', '2026-03-02', "another task's engine event"], ['occurrence', '2026-03-03', "another task's run"],
  ['none', '2026-03-04', 'nothing'], ['question', '2026-03-05', "the owner's unrelated question"],
];

describe('a reminder line written in another turn proves it', () => {
  for (const [kind, day, about] of doors) {
    it(`a turn rooted on ${about}: its lone dashboard line is accepted`, async () => {
      at(`${day}T07:38:00Z`);
      const shop = await reminder('Shop call', `${day}T07:53:00Z`);
      const root = await otherRoot(kind, day);
      at(`${day}T07:53:20Z`);
      let reminderLine = '';
      await turn(root, async () => {
        await checkScheduledTasks();
        reminderLine = line('Time to call the shop.', 'dashboard');
      });
      at(`${day}T07:54:40Z`);
      let r = { isError: true, content: '' };
      await turn({ kind: 'occurrence', id: openRun(shop) }, async () => { r = await handIn(shop, reminderLine); });
      expect(r.isError, r.content).toBe(false);
      expect(r.content).not.toContain('start line');
    });
  }
});
