// Every missed-run decision tells the owner on one card per task: which task, how many runs, why and what the
// engine did, in his own time. A second miss before he has seen the card raises its count instead of a new card.
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';

vi.mock('../../gateway/ws.js', () => ({ broadcast: () => {}, stampPersistedRow: (e: unknown) => e }));
vi.mock('../../agent/runtime.js', () => ({ getAgentRuntime: () => ({ handleMessage: async () => 'ran' }) }));
const box = await import('./helpers/missed-runs-box.js');
const { onTaskRunComplete } = await import('../runner.js');

beforeAll(() => box.openBox());
afterAll(() => box.closeBox());

describe('a missed run always makes one card', () => {
  it('a catch-up makes one card, and a second outage raises its count', async () => {
    box.at('2026-03-02T12:00:00Z');
    const id = await box.daily('Nightly brief', '2026-03-02T22:00:00Z');

    box.at('2026-03-09T08:00:00Z');
    await box.checkScheduledTasks();
    expect(box.cardsOf(id)).toEqual([
      '"Nightly brief" missed 7 scheduled runs because the Dojo was not running. '
      + 'The Dojo ran the one due Sun, Mar 8, 2026, 10:00 PM UTC now to catch up and skipped any older ones.',
    ]);

    await onTaskRunComplete(id, 'complete', 'the brief was sent');
    box.at('2026-03-12T08:00:00Z');
    await box.checkScheduledTasks();
    expect(box.cardsOf(id)).toHaveLength(1);
    expect(box.cardsOf(id)[0]).toMatch(/^"Nightly brief" missed 10 scheduled runs/);
  });

  it('runs with none recent enough are skipped, on a card that names the next run', async () => {
    box.at('2026-03-05T12:00:00Z');
    const id = await box.daily('Workday brief', '2026-03-06T07:00:00Z');
    box.db().prepare("UPDATE work SET repeat_unit = 'weekdays' WHERE id = ?").run(id);

    box.at('2026-03-09T06:00:00Z');   // Monday before seven: Friday's run is three days old
    await box.checkScheduledTasks();

    expect(box.runsOf(id)).toBe(0);
    expect(box.nextRunOf(id)).toBe(Date.parse('2026-03-09T07:00:00Z'));
    expect(box.cardsOf(id)).toEqual([
      '"Workday brief" missed 1 scheduled run because the Dojo was not running. '
      + 'None was recent enough to run, so they were skipped. The next run is Mon, Mar 9, 2026, 7:00 AM UTC.',
    ]);
  });
});
