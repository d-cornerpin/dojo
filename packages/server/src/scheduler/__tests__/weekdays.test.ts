import { describe, it, expect } from 'vitest';
import { calculateNextRun, formatRepeatPattern, type ScheduledTask } from '../engine.js';

function makeTask(overrides: Partial<ScheduledTask>): ScheduledTask {
  return {
    id: 't',
    scheduled_start: null,
    repeat_interval: null,
    repeat_unit: null,
    repeat_end_type: null,
    repeat_end_value: null,
    run_count: 0,
    is_paused: 0,
    last_run_at: null,
    next_run_at: null,
    schedule_status: 'scheduled',
    ...overrides,
  };
}

describe('weekdays repeat unit', () => {
  // Tests use dates far in the future so the engine's
  // "advance until future" loop is a no-op and we test the unit logic directly.

  it('advances Mon → Tue', () => {
    // Monday 2030-05-06 09:00 UTC
    const task = makeTask({
      scheduled_start: '2030-05-06T09:00:00Z',
      repeat_interval: 1,
      repeat_unit: 'weekdays',
      last_run_at: '2030-05-06T09:00:00Z',
      run_count: 1,
    });
    const next = calculateNextRun(task);
    expect(next).toBeTruthy();
    const nextDate = new Date(next!);
    expect(nextDate.getUTCDay()).toBe(2); // Tuesday
    expect(nextDate.getUTCDate()).toBe(7);
  });

  it('skips weekend: Fri → Mon', () => {
    // Friday 2030-05-10 09:00 UTC
    const task = makeTask({
      scheduled_start: '2030-05-10T09:00:00Z',
      repeat_interval: 1,
      repeat_unit: 'weekdays',
      last_run_at: '2030-05-10T09:00:00Z',
      run_count: 1,
    });
    const next = calculateNextRun(task);
    expect(next).toBeTruthy();
    const nextDate = new Date(next!);
    expect(nextDate.getUTCDay()).toBe(1); // Monday
    expect(nextDate.getUTCDate()).toBe(13);
  });

  it('handles being asked from Saturday: Sat → Mon', () => {
    // Pretend last_run landed on a Saturday somehow
    const task = makeTask({
      scheduled_start: '2030-05-11T09:00:00Z', // Saturday
      repeat_interval: 1,
      repeat_unit: 'weekdays',
      last_run_at: '2030-05-10T09:00:00Z', // Friday
      run_count: 1,
    });
    const next = calculateNextRun(task);
    expect(next).toBeTruthy();
    const nextDate = new Date(next!);
    expect(nextDate.getUTCDay()).toBe(1); // Monday
  });

  it('first run uses scheduled_start verbatim (no advance applied)', () => {
    const task = makeTask({
      scheduled_start: '2030-05-06T09:00:00Z',
      repeat_interval: 1,
      repeat_unit: 'weekdays',
      run_count: 0,
    });
    const next = calculateNextRun(task);
    expect(next).toBe('2030-05-06T09:00:00Z');
  });

  it('respects after_count end condition', () => {
    const task = makeTask({
      scheduled_start: '2030-05-06T09:00:00Z',
      repeat_interval: 1,
      repeat_unit: 'weekdays',
      repeat_end_type: 'after_count',
      repeat_end_value: '3',
      last_run_at: '2030-05-08T09:00:00Z',
      run_count: 3,
    });
    expect(calculateNextRun(task)).toBeNull();
  });
});

describe('formatRepeatPattern weekdays', () => {
  it('formats interval=1 as "Every weekday"', () => {
    expect(formatRepeatPattern(1, 'weekdays')).toBe('Every weekday');
  });

  it('formats interval>1 with the unit pluralized', () => {
    expect(formatRepeatPattern(3, 'weekdays')).toBe('Every 3 weekdays');
  });

  it('still handles other units', () => {
    expect(formatRepeatPattern(1, 'days')).toBe('Every day');
    expect(formatRepeatPattern(2, 'hours')).toBe('Every 2 hours');
  });
});
