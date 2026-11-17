// The nightly brief was due at 10 PM while the Dojo was off; the Dojo starts the next morning and runs it once,
// telling the agent it is a late catch-up of last night's run, and the schedule goes on to tonight. A Mondays-only
// task missed on Monday is caught up on Tuesday; a late first run only says when it was due.
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';

vi.mock('../../gateway/ws.js', () => ({ broadcast: () => {}, stampPersistedRow: (e: unknown) => e }));
vi.mock('../../agent/runtime.js', () => ({ getAgentRuntime: () => ({ handleMessage: async () => 'ran' }) }));
const box = await import('./helpers/missed-runs-box.js');

beforeAll(() => box.openBox());
afterAll(() => box.closeBox());

describe('a nightly task missed last night runs once when the Dojo starts', () => {
  it('fires once as a catch-up of the run due last night, then waits for tonight', async () => {
    box.at('2026-03-02T12:00:00Z');
    const id = await box.daily('Nightly brief', '2026-03-02T22:00:00Z');

    box.at('2026-03-03T08:00:00Z');
    await box.checkScheduledTasks();
    await box.checkScheduledTasks();

    expect(box.runsOf(id)).toBe(1);
    expect(box.triggers()).toHaveLength(1);
    expect(box.triggers()[0]).toMatch(/late: a catch-up of the run due Mon, Mar 2, 2026, 10:00 PM/);
    expect(box.nextRunOf(id)).toBe(Date.parse('2026-03-03T22:00:00Z'));
  });

  it('a Mondays-only task missed on Monday runs once on Tuesday', async () => {
    box.at('2026-03-01T12:00:00Z');
    const id = await box.daily('Weekly report', '2026-03-02T09:00:00Z');
    box.db().prepare("UPDATE work SET repeat_unit = 'specific_days', repeat_days_of_week = '1' WHERE id = ?").run(id);
    box.at('2026-03-03T10:00:00Z');
    await box.checkScheduledTasks();
    expect(box.runsOf(id)).toBe(1);
    expect(box.triggers().at(-1)).toMatch(/catch-up of the run due Mon, Mar 2, 2026, 9:00 AM/);
  });

  it('a late first run says only when it was due', async () => {
    box.at('2026-03-01T12:00:00Z');
    const made = await box.call('work_open', { kind: 'task', title: 'Water the garden', goal: 'it is watered', scheduled_start: '2026-03-01T13:00:00Z', allow_duplicate: true });
    expect(made.isError, made.content).toBeFalsy();
    box.at('2026-03-01T15:00:00Z');
    await box.checkScheduledTasks();
    expect(box.triggers().at(-1)).toMatch(/late: it was due Sun, Mar 1, 2026, 1:00 PM/);
  });
});
