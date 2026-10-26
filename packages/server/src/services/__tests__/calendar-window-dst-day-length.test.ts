import { describe, it, expect, vi, afterEach } from 'vitest';
import { computeCalendarWindow } from '../calendar-window.js';

describe('computeCalendarWindow DST day-length', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('ends at local midnight on the day clocks go forward (spring)', () => {
    // 2026-03-08 is the spring-forward day in America/Los_Angeles (PST→PDT),
    // so the local day is only 23 hours long. The window must end at the next
    // local midnight (07:00 UTC), not start + 24h (08:00 UTC, one hour late).
    const w = computeCalendarWindow({
      days: 1,
      timezone: 'America/Los_Angeles',
      start_date: '2026-03-08',
    });
    expect(w.startISO).toBe('2026-03-08T08:00:00.000Z');
    expect(w.endISO).toBe('2026-03-09T07:00:00.000Z');
  });

  it('ends at local midnight on the day clocks go back (fall)', () => {
    // 2026-11-01 is the fall-back day in America/Los_Angeles (PDT→PST),
    // so the local day is 25 hours long. The window must end at the next
    // local midnight (08:00 UTC), not start + 24h (07:00 UTC, one hour early).
    const w = computeCalendarWindow({
      days: 1,
      timezone: 'America/Los_Angeles',
      start_date: '2026-11-01',
    });
    expect(w.startISO).toBe('2026-11-01T07:00:00.000Z');
    expect(w.endISO).toBe('2026-11-02T08:00:00.000Z');
  });

  it('multi-day span crossing a spring-forward boundary ends at local midnight', () => {
    const w = computeCalendarWindow({
      days: 7,
      timezone: 'America/Los_Angeles',
      start_date: '2026-03-07',
    });
    expect(w.endISO).toBe('2026-03-14T07:00:00.000Z');
  });

  it('timezone-only branch ends at local midnight on a spring-forward day', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-03-08T12:00:00Z'));
    const w = computeCalendarWindow({ timezone: 'America/Los_Angeles' });
    expect(w.startISO).toBe('2026-03-08T08:00:00.000Z');
    expect(w.endISO).toBe('2026-03-09T07:00:00.000Z');
  });

  it('non-DST zones and year rollover are unaffected', () => {
    const tokyo = computeCalendarWindow({
      days: 1,
      timezone: 'Asia/Tokyo',
      start_date: '2026-05-20',
    });
    expect(tokyo.startISO).toBe('2026-05-19T15:00:00.000Z');
    expect(tokyo.endISO).toBe('2026-05-20T15:00:00.000Z');

    const utc = computeCalendarWindow({
      days: 2,
      timezone: 'UTC',
      start_date: '2026-12-31',
    });
    expect(utc.endISO).toBe('2027-01-02T00:00:00.000Z');
  });

  it('no-timezone branch stays a plain 48h duration', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-03-08T12:00:00Z'));
    const w = computeCalendarWindow({ days: 2 });
    expect(w.anchored).toBe(false);
    const endMs = new Date(w.endISO).getTime();
    const startMs = new Date(w.startISO).getTime();
    expect(endMs - startMs).toBe(2 * 86400000);
  });
});
