// Each missed-run decision writes one log line with its cause: the task was on hold, or the Dojo was running
// but its clock did not tick (the Mac asleep or the Dojo busy).
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import type { LogEntry } from '@dojo/shared';

vi.mock('../../gateway/ws.js', () => ({ broadcast: () => {}, stampPersistedRow: (e: unknown) => e }));
vi.mock('../../agent/runtime.js', () => ({ getAgentRuntime: () => ({ handleMessage: async () => 'ran' }) }));
const box = await import('./helpers/missed-runs-box.js');
const { setLogBroadcast } = await import('../../logger.js');
const { setHold, clearHold } = await import('../../work/done/hold.js');

const lines: LogEntry[] = [];
beforeAll(() => { box.openBox(); setLogBroadcast((e) => { lines.push(e); }); });
afterAll(() => box.closeBox());
const causeOf = (id: string): unknown => lines.find((l) => l.message === 'Scheduler: missed runs' && l.meta?.taskId === id)?.meta?.cause;

describe('the log says why a scheduled run was missed', () => {
  it('a run missed while the task was on hold', async () => {
    box.at('2026-03-02T12:00:00Z');
    const id = await box.daily('Held brief', '2026-03-02T22:00:00Z');
    expect(setHold(id, 'paused', 'the owner is away', 'owner').ok).toBe(true);
    box.at('2026-03-03T08:00:00Z');
    expect(clearHold(id, 'owner')).toBe(true);
    await box.checkScheduledTasks();
    expect(causeOf(id)).toBe('the task was on hold');
  });

  it('a run missed while this Dojo was running', async () => {
    box.at('2027-03-02T12:00:00Z');
    const id = await box.daily('Asleep brief', '2027-03-02T22:00:00Z');
    box.at('2027-03-03T08:00:00Z');
    await box.checkScheduledTasks();
    expect(causeOf(id)).toBe('the Mac was asleep or the Dojo was busy');
  });
});
