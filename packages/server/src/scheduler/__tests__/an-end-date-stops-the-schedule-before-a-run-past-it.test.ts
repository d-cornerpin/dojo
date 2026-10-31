import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { calculateNextRun, type ScheduledTask } from '../engine.js';

function makeTask(overrides: Partial<ScheduledTask>): ScheduledTask {
  return {
    id: 't',
    scheduled_start: '2026-07-01T09:00:00.000Z',
    anchor_time: '2026-07-01T09:00:00.000Z',
    tz: 'UTC',
    repeat_interval: 1,
    repeat_unit: 'days',
    repeat_end_type: 'on_date',
    repeat_end_value: '2026-07-10',
    run_count: 3,
    last_run_at: '2026-07-10T09:00:00.000Z',
    is_paused: 0,
    next_run_at: null,
    schedule_status: 'waiting',
    ...overrides,
  } as ScheduledTask;
}

describe('an end date stops the schedule before a run past it', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-10T10:00:00Z'));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('returns null when the next daily run is past the end date', () => {
    expect(calculateNextRun(makeTask({ repeat_end_value: '2026-07-10' }))).toBeNull();
  });

  it('keeps the next daily run when it is still inside the end date', () => {
    expect(calculateNextRun(makeTask({ repeat_end_value: '2026-07-11' }))).toBe('2026-07-11T09:00:00.000Z');
  });

  it('applies to hourly steps with a full-timestamp end', () => {
    const base = { repeat_unit: 'hours', repeat_interval: 2, last_run_at: '2026-07-10T10:00:00.000Z', anchor_time: '2026-07-10T10:00:00.000Z' } as Partial<ScheduledTask>;
    expect(calculateNextRun(makeTask({ ...base, repeat_end_value: '2026-07-10T11:00:00Z' }))).toBeNull();
    expect(calculateNextRun(makeTask({ ...base, repeat_end_value: '2026-07-10T12:00:00Z' }))).toBe('2026-07-10T12:00:00.000Z');
  });

  it('a schedule with no end still returns the next run', () => {
    expect(calculateNextRun(makeTask({ repeat_end_type: 'never', repeat_end_value: null }))).toBe('2026-07-11T09:00:00.000Z');
  });
});
