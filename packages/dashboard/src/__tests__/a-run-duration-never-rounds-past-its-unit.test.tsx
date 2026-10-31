// Fresh-eyes slice 10 (2026-10-31). The run-history duration helper rounded, so a 59.6 s run —
// a minute short of a minute — printed "60s", a 59.7-minute run printed "60m", and the hour
// figure jumped its unit at the half (89 min "1h", 90 min "2h"). It floors the seconds and
// minutes branches instead, names the minutes alongside the hours, and answers a run that ends
// before it starts (a clock step) with the same `--` as a missing timestamp. `formatDuration`
// is exported (same name) so these bytes are testable without mounting the table.
import { describe, it, expect } from 'vitest';
import { formatDuration } from '../components/TaskRunHistory';

const START = '2026-10-28T12:00:00.000Z';
const startMs = Date.parse(START);
const after = (ms: number) => new Date(ms + startMs).toISOString();

describe('a run duration never rounds past its unit', () => {
  it('a 59.6-second run says 59s, not 60s', () => {
    expect(formatDuration(START, after(59_600))).toBe('59s');
  });

  it('a 59.7-minute run says 59m, not 60m', () => {
    expect(formatDuration(START, after(3_580_000))).toBe('59m');
  });

  it('89 minutes says 1h 29m, and exactly 2 hours says 2h with no trailing minutes', () => {
    expect(formatDuration(START, after(5_340_000))).toBe('1h 29m');
    expect(formatDuration(START, after(7_200_000))).toBe('2h');
  });

  it('a run that ends before it starts (a clock step) reads --, not <1s', () => {
    expect(formatDuration(START, after(-1_000))).toBe('--');
  });

  it('under a second still reads <1s', () => {
    expect(formatDuration(START, after(400))).toBe('<1s');
  });
});
