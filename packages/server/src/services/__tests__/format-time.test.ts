import { describe, it, expect } from 'vitest';
import { parseFlexibleTime, formatTimeRangeForAgent } from '../format-time.js';

describe('parseFlexibleTime — Microsoft Graph naked ISO + zone', () => {
  // v2.7.26 regression — Microsoft Graph returns event times as naked ISO
  // ("2026-06-01T19:00:00.0000000") with a separate `timeZone` field.
  // parseFlexibleTime routes those through interpretLocalAsTz, which
  // formats parts with Intl.DateTimeFormat then rebuilds an ISO string.
  // The day field was set to `numeric` which returned "1" rather than
  // "01" for single-digit days, producing an invalid reconstructed ISO
  // and a returned Invalid Date. Result: every recurring calendar event
  // on June 1–9, July 1–9, etc. surfaced as "(invalid time: Invalid Date)".

  it('parses single-digit day in UTC (June 1 case)', () => {
    const d = parseFlexibleTime('2026-06-01T19:00:00.0000000', 'UTC');
    expect(d).not.toBeNull();
    expect(isNaN(d!.getTime())).toBe(false);
    expect(d!.toISOString()).toBe('2026-06-01T19:00:00.000Z');
  });

  it('parses single-digit day in IANA zone', () => {
    const d = parseFlexibleTime('2026-06-01T12:00:00.0000000', 'America/Los_Angeles');
    expect(d).not.toBeNull();
    expect(isNaN(d!.getTime())).toBe(false);
    // 12:00 PDT (UTC-7) = 19:00 UTC
    expect(d!.toISOString()).toBe('2026-06-01T19:00:00.000Z');
  });

  it('still parses two-digit day correctly (regression check)', () => {
    const d = parseFlexibleTime('2026-06-15T12:00:00.0000000', 'America/Los_Angeles');
    expect(d).not.toBeNull();
    expect(d!.toISOString()).toBe('2026-06-15T19:00:00.000Z');
  });

  it('returns null on unrecognized timezone (Windows zone name) instead of throwing', () => {
    // v2.7.26 — defensive try/catch around the Intl call. Microsoft Graph
    // used to hand back Windows zone names ("Pacific Standard Time") before
    // we added the Prefer header; if some other provider does the same in
    // the future, we want to return null gracefully rather than throw.
    expect(() =>
      parseFlexibleTime('2026-06-01T12:00:00.0000000', 'Pacific Standard Time'),
    ).not.toThrow();
    const d = parseFlexibleTime('2026-06-01T12:00:00.0000000', 'Pacific Standard Time');
    expect(d).toBeNull();
  });
});

describe('formatTimeRangeForAgent — end-to-end with the bug shape', () => {
  it('produces a real time range for parsed single-digit-day events (no "Invalid Date")', () => {
    const start = parseFlexibleTime('2026-06-01T19:00:00.0000000', 'UTC');
    const end = parseFlexibleTime('2026-06-01T19:30:00.0000000', 'UTC');
    expect(start && end).toBeTruthy();
    const out = formatTimeRangeForAgent(start!, end!, { timezone: 'America/Los_Angeles' });
    expect(out).not.toMatch(/Invalid Date/);
    expect(out).not.toMatch(/invalid time/);
    expect(out).toMatch(/2026/);
    expect(out).toMatch(/12:00 PM/);
  });
});
