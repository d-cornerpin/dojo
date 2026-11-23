// O-20 as lived (the bread reminder texted again): a reminder fires, its own turn texts it and the run closes on that
// text. In every later view the run's trigger row says it was delivered, so a later turn does not send it again. A run
// still open carries no mark.
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';

vi.mock('../../gateway/ws.js', () => ({ broadcast: () => {}, stampPersistedRow: (e: unknown) => e }));
vi.mock('../../agent/v2/loop.js', () => ({ runV2Turn: async () => {} }));
const box = await import('./helpers/reminders-box.js');
const { at, db, turn, line, reminder, openRun, runState, checkScheduledTasks, closeRunsThatDelivered, MAIN } = box;
const { labelRows } = await import('../../memory/row-label.js');
const { getRecentMessages } = await import('../../memory/store.js');

beforeAll(() => box.openBox());
afterAll(() => box.closeBox());

const triggerLabel = (run: string): string => {
  const id = (db().prepare('SELECT id FROM messages WHERE run_id = ? ORDER BY seq LIMIT 1').get(run) as { id: string }).id;
  return labelRows(MAIN, getRecentMessages(MAIN, 500)).get(id) ?? '';
};

describe('a delivered reminder is marked delivered in the next view', () => {
  it('the bread reminder: open, no mark; texted by its own turn and closed, its trigger row says delivered', async () => {
    at('2026-03-02T07:30:00Z');
    const bread = await reminder('Bread reminder', '2026-03-02T07:45:00Z');
    at('2026-03-02T07:45:25Z');
    await checkScheduledTasks();
    const run = openRun(bread);
    expect(triggerLabel(run)).not.toContain('delivered');
    await turn({ kind: 'occurrence', id: run }, () => { line('Time to take the bread out.', 'imessage'); });
    await closeRunsThatDelivered();
    expect(runState(bread).state).toBe('done');
    expect(triggerLabel(run)).toContain(' · delivered: do not send it again');
  });
});
