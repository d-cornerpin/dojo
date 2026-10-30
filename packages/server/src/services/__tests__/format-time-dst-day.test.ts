import { describe, it, expect } from 'vitest';
import { parseFlexibleTime } from '../format-time.js';

// The exact-converter contract: a naive wall time ("2026-03-08T09:00:00")
// interpreted in a zone must land on the right instant even on DST
// transition days — when the clock jumps forward (spring) or back (fall)
// the offset looked up by treating the wall time as UTC can sit on the
// other side of the change. `wallToInstant` in scheduler/engine.ts probes
// both sides and resolves those cases; `interpretLocalAsTz` must agree.

const expectInstant = (input: string, fromTz: string, expected: string) => {
  const d = parseFlexibleTime(input, fromTz);
  expect(d).not.toBeNull();
  expect(isNaN(d!.getTime())).toBe(false);
  expect(d!.toISOString()).toBe(expected);
};

describe('parseFlexibleTime — DST transition days', () => {
  it('spring forward (America/Los_Angeles 09:00 on 2026-03-08)', () => {
    expectInstant('2026-03-08T09:00:00', 'America/Los_Angeles', '2026-03-08T16:00:00.000Z');
  });

  it('spring forward just before the gap (America/Los_Angeles 03:30 on 2026-03-08)', () => {
    expectInstant('2026-03-08T03:30:00', 'America/Los_Angeles', '2026-03-08T10:30:00.000Z');
  });

  it('fall back (America/Los_Angeles 03:00 on 2026-11-01)', () => {
    expectInstant('2026-11-01T03:00:00', 'America/Los_Angeles', '2026-11-01T11:00:00.000Z');
  });

  it('spring forward (Europe/Berlin 01:30 on 2026-03-29)', () => {
    expectInstant('2026-03-29T01:30:00', 'Europe/Berlin', '2026-03-29T00:30:00.000Z');
  });

  it('guards — wall times a day or more from a change are unaffected', () => {
    expectInstant('2026-03-08T01:00:00', 'America/Los_Angeles', '2026-03-08T09:00:00.000Z');
    expectInstant('2026-03-08T12:00:00', 'America/Los_Angeles', '2026-03-08T19:00:00.000Z');
    expectInstant('2026-11-01T09:00:00', 'America/Los_Angeles', '2026-11-01T17:00:00.000Z');
    expectInstant('2026-03-29T04:00:00', 'Europe/Berlin', '2026-03-29T02:00:00.000Z');
    expectInstant('2026-10-25T04:00:00', 'Europe/Berlin', '2026-10-25T03:00:00.000Z');
    expectInstant('2026-05-20T09:00:00', 'Asia/Tokyo', '2026-05-20T00:00:00.000Z');
    expectInstant('2026-05-20T00:30:00', 'UTC', '2026-05-20T00:30:00.000Z');
  });

  it('rejects a Windows timezone name without throwing', () => {
    expect(() => parseFlexibleTime('2026-05-20T09:00:00', 'Pacific Standard Time')).not.toThrow();
    expect(parseFlexibleTime('2026-05-20T09:00:00', 'Pacific Standard Time')).toBeNull();
  });

  it('an impossible date or time in a zone is null, not a wrong instant', () => {
    expect(parseFlexibleTime('2026-13-01T10:00:00', 'America/Los_Angeles')).toBeNull();
    expect(parseFlexibleTime('2026-05-20T25:00:00', 'America/Los_Angeles')).toBeNull();
  });

  it('a Z-suffixed ISO still parses without a fromTz', () => {
    const d = parseFlexibleTime('2026-05-20T09:00:00Z');
    expect(d).not.toBeNull();
    expect(d!.toISOString()).toBe('2026-05-20T09:00:00.000Z');
  });
});
