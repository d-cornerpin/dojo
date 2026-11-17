// The nightly brief was due at 10 PM while the Dojo was off; the Dojo starts the next morning and runs it once,
// telling the agent it is a late catch-up of last night's run, and the schedule goes on to tonight.
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
});
