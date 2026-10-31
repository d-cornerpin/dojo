// A WALL CLOCK THE CALENDAR DOES NOT HAVE MUST BE REFUSED, NOT NORMALISED.
//
// WALL_CLOCK_RE (src/tracker/tools.ts) checks the SHAPE of the string, so
// "2026-02-31T09:00", "2026-13-01T09:00" and "2026-07-16T25:00" all pass it,
// and wallToInstant normalises the overflow: Feb 31 landed on Mar 3 and the
// success echo showed a day nobody asked for. The four refusal clauses below
// failed before the fix. The accepted clauses pin the neighbours: Feb 28, a
// real leap day (2028), and 02:30 on US spring-forward day — a wall time in a
// DST gap is not a date that does not exist; it resolves forward within the
// same day and stays accepted.
import { describe, it, expect } from 'vitest';
import { resolveLocalWallClock } from '../tools.js';

function expectRefused(r: ReturnType<typeof resolveLocalWallClock>) {
  expect(r.ok).toBe(false);
  if (r.ok) return;
  expect(r.error).toContain('did not resolve to a valid instant');
}

describe('resolveLocalWallClock refuses dates that do not exist', () => {
  it.each([
    ['Feb 31', '2026-02-31T09:00'],
    ['month 13', '2026-13-01T09:00'],
    ['hour 25', '2026-07-16T25:00'],
    ['minute 60', '2026-07-16T09:60'],
  ])('refuses %s', (_name, localTime) => {
    expectRefused(resolveLocalWallClock(localTime, 'UTC'));
  });

  it('accepts a plain date and time, with the exact instant', () => {
    expect(resolveLocalWallClock('2026-02-28T09:00', 'UTC')).toEqual({
      ok: true,
      iso: '2026-02-28T09:00:00.000Z',
      zone: 'UTC',
    });
  });

  it('accepts a real leap day', () => {
    expect(resolveLocalWallClock('2028-02-29T09:00', 'UTC').ok).toBe(true);
  });

  it('accepts a time inside the US spring-forward gap', () => {
    expect(resolveLocalWallClock('2026-03-08T02:30', 'America/Los_Angeles').ok).toBe(true);
  });
});
