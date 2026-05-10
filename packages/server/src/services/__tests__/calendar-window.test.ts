import { describe, it, expect } from 'vitest';
import { computeCalendarWindow } from '../calendar-window.js';

describe('computeCalendarWindow', () => {
  it('anchors to local midnight in the given timezone via start_date', () => {
    const w = computeCalendarWindow({
      days: 1,
      timezone: 'America/Los_Angeles',
      start_date: '2026-05-13', // Wednesday
    });
    // PT is UTC-7 in May (PDT). So Wed 00:00 PT = Wed 07:00 UTC.
    expect(w.startISO).toBe('2026-05-13T07:00:00.000Z');
    expect(w.endISO).toBe('2026-05-14T07:00:00.000Z');
    expect(w.anchored).toBe(true);
    expect(w.timezone).toBe('America/Los_Angeles');
  });

  it('handles UTC-positive timezones correctly', () => {
    const w = computeCalendarWindow({
      days: 1,
      timezone: 'Europe/Berlin',
      start_date: '2026-05-13', // CEST = UTC+2
    });
    expect(w.startISO).toBe('2026-05-12T22:00:00.000Z');
    expect(w.endISO).toBe('2026-05-13T22:00:00.000Z');
  });

  it('handles a multi-day span anchored to a local date', () => {
    const w = computeCalendarWindow({
      days: 7,
      timezone: 'America/Los_Angeles',
      start_date: '2026-05-11', // Monday
    });
    expect(w.startISO).toBe('2026-05-11T07:00:00.000Z');
    expect(w.endISO).toBe('2026-05-18T07:00:00.000Z');
  });

  it('handles standard time (winter offset)', () => {
    const w = computeCalendarWindow({
      days: 1,
      timezone: 'America/Los_Angeles',
      start_date: '2026-01-15', // PST = UTC-8
    });
    expect(w.startISO).toBe('2026-01-15T08:00:00.000Z');
  });

  it('falls back to "now → now+days" when no timezone or start_date provided', () => {
    const before = Date.now();
    const w = computeCalendarWindow({ days: 1 });
    const after = Date.now();
    const startMs = new Date(w.startISO).getTime();
    expect(startMs).toBeGreaterThanOrEqual(before);
    expect(startMs).toBeLessThanOrEqual(after);
    expect(w.anchored).toBe(false);
    const endMs = new Date(w.endISO).getTime();
    expect(endMs - startMs).toBe(86400000);
  });

  it('snaps to today-local-midnight when timezone is provided alone', () => {
    const w = computeCalendarWindow({ days: 1, timezone: 'America/Los_Angeles' });
    expect(w.anchored).toBe(true);
    // Start should be a midnight boundary in PT — i.e. 07:00 or 08:00 UTC depending on DST
    const minutes = new Date(w.startISO).getUTCMinutes();
    expect(minutes).toBe(0);
    const hours = new Date(w.startISO).getUTCHours();
    expect([7, 8]).toContain(hours);
  });

  it('clamps days to a minimum of 1', () => {
    const w = computeCalendarWindow({ days: 0, timezone: 'America/Los_Angeles', start_date: '2026-05-13' });
    const span = new Date(w.endISO).getTime() - new Date(w.startISO).getTime();
    expect(span).toBe(86400000);
  });
});
