// Stop on a scheduled job's run ends that run (settled as skipped, the schedule waiting for its next time); the
// schedule is not held, so the next run fires as set.
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';

vi.mock('../../gateway/ws.js', () => ({ broadcast: () => {}, stampPersistedRow: (e: unknown) => e }));
vi.mock('../../agent/v2/loop.js', () => ({ runV2Turn: async () => {} }));
const box = await import('./helpers/missed-runs-box.js');
const { stopByOwner } = await import('../../agent/runtime.js');
const { openTurnContext, endTurnContext } = await import('../../agent/turn-context.js');

beforeAll(() => box.openBox());
afterAll(() => box.closeBox());

const occurrences = (id: string) => box.db().prepare("SELECT id, state FROM work WHERE kind = 'occurrence' AND parent_id = ? ORDER BY sequence").all(id) as Array<{ id: string; state: string }>;

describe('stop on a scheduled run ends that run and the next one fires', () => {
  it('the run is settled skipped, the task is not held, and tomorrow it runs again', async () => {
    box.at('2026-03-02T12:00:00Z');
    const id = await box.daily('Nightly brief', '2026-03-02T22:00:00Z');
    box.at('2026-03-02T22:00:30Z');
    await box.checkScheduledTasks();
    const [run] = occurrences(id);
    const bag = openTurnContext(box.MAIN);
    Object.assign(bag, { turnNumber: 1, root: { kind: 'occurrence', id: run.id, sourceMessageId: null } });
    expect(stopByOwner(box.MAIN)).toMatchObject({ ended: 1 });
    endTurnContext(box.MAIN);
    await vi.waitFor(() => expect(occurrences(id)[0].state).not.toBe('open'));
    expect(box.db().prepare('SELECT hold_kind AS hold, schedule_status AS s FROM work WHERE id = ?').get(id)).toEqual({ hold: null, s: 'waiting' });

    box.at('2026-03-03T22:00:30Z');
    await box.checkScheduledTasks();
    expect(box.runsOf(id)).toBe(2);
  });
});
