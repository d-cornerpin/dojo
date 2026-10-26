// T277 — A MONTH-END ANCHOR DOES NOT DRIFT OFF ITS OWN DAY.
//
// ── WHY THIS FILE EXISTS ──
// A monthly/yearly schedule is anchored on a wall clock (e.g. the 31st). The engine walks
// that anchor forward one interval at a time, and `normalizeWall` lets an impossible date
// OVERFLOW: Jan 31 + 1 month is "Feb 31", which becomes Mar 3. The walk then carries the
// wrong day forward, so a 31st-anchored schedule never comes back to the 31st (measured on
// v35 in 'UTC': asked on 2026-02-01 a 2026-01-31-anchored task says the next run is
// 2026-03-03, skipping February entirely). The fix derives each month/year candidate from
// the ANCHOR wall clock (N x interval months), clamping the day to the target month's
// length, instead of from the previous already-clamped occurrence. These tests pin that:
// Jan 31 -> Feb 28 -> Mar 31 -> Apr 30, and a leap-day anchor survives to its next leap day.

import { afterEach, describe, expect, it, vi } from 'vitest';
import { calculateNextRun, type ScheduledTask } from '../engine.js';

const TZ = 'UTC';

function task(over: Partial<ScheduledTask>): ScheduledTask {
  return {
    id: 't1',
    scheduled_start: null,
    repeat_interval: 1,
    repeat_unit: 'months',
    repeat_end_type: null,
    repeat_end_value: null,
    run_count: 1,
    is_paused: 0,
    last_run_at: null,
    next_run_at: null,
    schedule_status: 'waiting',
    repeat_days_of_week: null,
    tz: null,
    ...over,
  };
}

describe('T277: a monthly schedule keeps its anchor day across short months', () => {
  afterEach(() => { vi.useRealTimers(); });

  it('1 · Jan 31 anchor, asked on Feb 1: next run is Feb 28, not Mar 3', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-02-01T00:00:00Z'));
    const next = calculateNextRun(task({
      scheduled_start: '2026-01-31T09:00:00.000Z',
      anchor_time: '2026-01-31T09:00:00.000Z',
      last_run_at: '2026-01-31T09:00:00.000Z',
      run_count: 1,
    }), TZ);
    expect(next).toBe('2026-02-28T09:00:00.000Z');
  });

  it('2 · after Feb 28, the schedule returns to the 31st: asked on Mar 4, next run is Mar 31', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-03-04T00:00:00Z'));
    const next = calculateNextRun(task({
      scheduled_start: '2026-01-31T09:00:00.000Z',
      anchor_time: '2026-01-31T09:00:00.000Z',
      last_run_at: '2026-02-28T09:00:00.000Z',
      run_count: 2,
    }), TZ);
    expect(next).toBe('2026-03-31T09:00:00.000Z');
  });

  it('3 · Mar 31 at 10:00Z: next run is Apr 30, not Apr 3', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-03-31T10:00:00Z'));
    const next = calculateNextRun(task({
      scheduled_start: '2026-01-31T09:00:00.000Z',
      anchor_time: '2026-01-31T09:00:00.000Z',
      last_run_at: '2026-03-31T09:00:00.000Z',
      run_count: 3,
    }), TZ);
    expect(next).toBe('2026-04-30T09:00:00.000Z');
  });

  it('4 · every 2 months, Dec 31 anchor, asked on Jan 1: next run is Feb 28', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
    const next = calculateNextRun(task({
      repeat_interval: 2,
      scheduled_start: '2025-12-31T09:00:00.000Z',
      anchor_time: '2025-12-31T09:00:00.000Z',
      last_run_at: '2025-12-31T09:00:00.000Z',
      run_count: 1,
    }), TZ);
    expect(next).toBe('2026-02-28T09:00:00.000Z');
  });

  it('5 · yearly Feb 29 anchor survives: asked on 2027-03-01, next run is 2028-02-29, not 2027-03-01', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2027-03-01T00:00:00Z'));
    const next = calculateNextRun(task({
      repeat_unit: 'years',
      scheduled_start: '2024-02-29T09:00:00.000Z',
      anchor_time: '2024-02-29T09:00:00.000Z',
      last_run_at: '2026-02-28T09:00:00.000Z',
      run_count: 1,
    }), TZ);
    expect(next).toBe('2028-02-29T09:00:00.000Z');
  });

  it('6 · GUARD: a mid-month anchor keeps its exact day (Jan 15 -> Feb 15)', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-02-01T00:00:00Z'));
    const next = calculateNextRun(task({
      scheduled_start: '2026-01-15T09:00:00.000Z',
      anchor_time: '2026-01-15T09:00:00.000Z',
      run_count: 1,
    }), TZ);
    expect(next).toBe('2026-02-15T09:00:00.000Z');
  });

  it('6b · GUARD: a brand-new task with no anchor returns scheduled_start unchanged', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
    const next = calculateNextRun(task({
      scheduled_start: '2026-01-31T09:00:00.000Z',
      run_count: 0,
      last_run_at: null,
    }), TZ);
    expect(next).toBe('2026-01-31T09:00:00.000Z');
  });
});
