// The export filename uses today's LOCAL calendar day. `toISOString()` is UTC, so
// late in the evening in a zone behind UTC the file was stamped tomorrow, and early
// in the morning in a zone ahead of UTC it was stamped yesterday. `localDateStamp`
// reads the local day. Both cases pass in every timezone because both sides are
// local; the old UTC expression failed them behind / ahead of UTC respectively.
import { describe, it, expect } from 'vitest';
import { localDateStamp } from '../lib/dates';

describe('the export file is named for today’s local date', () => {
  it('stamps a late local evening as that day, even in a zone behind UTC', () => {
    expect(localDateStamp(new Date(2026, 9, 31, 23, 30))).toBe('2026-10-31');
  });

  it('stamps an early local morning as that day, even in a zone ahead of UTC', () => {
    expect(localDateStamp(new Date(2026, 0, 1, 0, 5))).toBe('2026-01-01');
  });
});
