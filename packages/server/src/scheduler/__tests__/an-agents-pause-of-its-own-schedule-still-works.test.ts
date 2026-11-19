// The agent pauses its own repeating task through the ordinary pause: while paused, a long outage fires nothing
// and makes no card, and a resume walks to the next run with no catch-up.
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';

vi.mock('../../gateway/ws.js', () => ({ broadcast: () => {}, stampPersistedRow: (e: unknown) => e }));
vi.mock('../../agent/runtime.js', () => ({ getAgentRuntime: () => ({ handleMessage: async () => 'ran' }) }));
const box = await import('./helpers/missed-runs-box.js');

beforeAll(() => box.openBox());
afterAll(() => box.closeBox());

describe("an agent's pause of its own schedule still works", () => {
  it('paused, nothing fires and no card is made; resumed, it waits for its next time', async () => {
    box.at('2026-03-02T12:00:00Z');
    const id = await box.daily('Nightly brief', '2026-03-02T22:00:00Z');
    const paused = await box.call('work_schedule', { action: 'pause', task_id: id });
    expect(paused.isError, paused.content).toBeFalsy();

    box.at('2026-03-09T08:00:00Z');
    await box.checkScheduledTasks();
    expect(box.runsOf(id)).toBe(0);

    const resumed = await box.call('work_schedule', { action: 'resume', task_id: id });
    expect(resumed.isError, resumed.content).toBeFalsy();
    await box.checkScheduledTasks();
    expect(box.runsOf(id)).toBe(0);
    expect(box.nextRunOf(id)).toBe(Date.parse('2026-03-09T22:00:00Z'));
    expect(box.cardsOf(id)).toEqual([]);
  });

  it('the schedule tool offers only pause and resume', async () => {
    const out = await box.call('work_schedule', { task_id: 'anything', resolution: 'skip' });
    expect(out.content).toMatch(/needs action: "pause" or "resume"/);
  });
});
