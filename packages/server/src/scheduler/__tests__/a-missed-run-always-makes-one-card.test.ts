// Every missed-run decision tells the owner on one card per task: which task, how many runs, why and what the
// engine did, in his own time. A second miss before he has seen the card raises its count; once he has seen it,
// the next miss starts a new count.
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';

vi.mock('../../gateway/ws.js', () => ({ broadcast: () => {}, stampPersistedRow: (e: unknown) => e }));
vi.mock('../../agent/runtime.js', () => ({ getAgentRuntime: () => ({ handleMessage: async () => 'ran' }) }));
const box = await import('./helpers/missed-runs-box.js');
const { onTaskRunComplete } = await import('../runner.js');
const { servedOwnerNotices } = await import('../../healer/owner-notice-kinds.js');

beforeAll(() => box.openBox());
afterAll(() => box.closeBox());

describe('a missed run always makes one card', () => {
  it('a catch-up makes one card; a second outage raises its count until he has seen it', async () => {
    box.at('2026-03-02T12:00:00Z');
    const id = await box.daily('Brief, missed 3 times last year', '2026-03-02T22:00:00Z');

    box.at('2026-03-09T08:00:00Z');
    await box.checkScheduledTasks();
    expect(box.cardsOf(id)).toEqual([
      '"Brief, missed 3 times last year" missed 7 scheduled runs because the Dojo was not running. '
      + 'The Dojo ran the one due Mar 8, 2026, 10:00 PM UTC+00:00 now to catch up and skipped any older ones.',
    ]);

    await onTaskRunComplete(id, 'complete', 'the brief was sent');
    box.at('2026-03-12T08:00:00Z');
    await box.checkScheduledTasks();
    expect(box.cardsOf(id)).toHaveLength(1);
    expect(box.cardsOf(id)[0]).toMatch(/^"Brief, missed 3 times last year" missed 10 scheduled runs/);

    servedOwnerNotices();
    await onTaskRunComplete(id, 'complete', 'the brief was sent');
    box.at('2026-03-14T08:00:00Z');
    await box.checkScheduledTasks();
    expect(box.cardsOf(id)[0]).toMatch(/^"Brief, missed 3 times last year" missed 2 scheduled runs/);
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
      + 'None was recent enough to run, so they were skipped. The next run is Mar 9, 2026, 07:00 AM UTC+00:00.',
    ]);
  });
});
