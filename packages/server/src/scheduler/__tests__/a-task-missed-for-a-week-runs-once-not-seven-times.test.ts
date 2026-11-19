// The Dojo was off for a week: the nightly task runs once, for the newest missed night, and the six older nights
// are skipped. A second pass after the same outage fires nothing more.
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';

vi.mock('../../gateway/ws.js', () => ({ broadcast: () => {}, stampPersistedRow: (e: unknown) => e }));
vi.mock('../../agent/runtime.js', () => ({ getAgentRuntime: () => ({ handleMessage: async () => 'ran' }) }));
const box = await import('./helpers/missed-runs-box.js');

beforeAll(() => box.openBox());
afterAll(() => box.closeBox());

describe('a task missed for a week runs once, not seven times', () => {
  it('fires one catch-up of the newest night and walks on to tonight', async () => {
    box.at('2026-03-02T12:00:00Z');
    const id = await box.daily('Nightly brief', '2026-03-02T22:00:00Z');

    box.at('2026-03-09T08:00:00Z');
    for (let i = 0; i < 3; i++) await box.checkScheduledTasks();

    expect(box.runsOf(id)).toBe(1);
    expect(box.triggers()).toHaveLength(1);
    expect(box.triggers()[0]).toMatch(/catch-up of the run due Sun, Mar 8, 2026, 10:00 PM/);
    expect(box.db().prepare("SELECT next_run_at FROM work WHERE kind = 'occurrence' AND parent_id = ?").get(id))
      .toEqual({ next_run_at: Date.parse('2026-03-08T22:00:00Z') });   // the run history names the same run
    expect(box.nextRunOf(id)).toBe(Date.parse('2026-03-09T22:00:00Z'));
  });
});
