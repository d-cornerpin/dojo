// Five pure helpers turn typed model input into Google API shapes and none of
// them had a test: the A1 → grid conversion behind sheets_format (Google's end
// indexes are EXCLUSIVE), hex → 0-1 colour parts, and the Calendar date-only /
// UTC-offset / exclusive-all-day-end helpers. An off-by-one here formats the
// wrong cells or makes a one-day event zero-length.

import { describe, it, expect, vi } from 'vitest';

// Cutting the transport at the mock keeps tools-write's import chain off the
// agent loop (client.js pulls gateway/ws + agent/v2/outbound, which close the
// cycle back onto tools-write). The helpers under test never call it.
vi.mock('../client.js', () => ({ googleRead: vi.fn(), googleWrite: vi.fn() }));

import {
  a1ToGridRange,
  addOneCalendarDay,
  hasUtcOffset,
  hexToRgb,
  isDateOnly,
} from '../tools-write.js';

type Grid = {
  sheetId: number;
  startRowIndex: number;
  endRowIndex: number;
  startColumnIndex: number;
  endColumnIndex: number;
};

const sheets = [
  { properties: { sheetId: 11, title: 'Sheet1' } },
  { properties: { sheetId: 22, title: 'My Data' } },
];

const grid = (a1: string, sheetList = sheets) => a1ToGridRange(a1, sheetList) as Grid;
const parseError = (a1: string, sheetList = sheets) => a1ToGridRange(a1, sheetList) as { error: string };

describe('a1ToGridRange', () => {
  it('turns a single cell into a one-cell range on the first sheet', () => {
    expect(grid('A1')).toEqual({
      sheetId: 11, startRowIndex: 0, endRowIndex: 1, startColumnIndex: 0, endColumnIndex: 1,
    });
    expect(grid('Sheet1!A1')).toEqual(grid('A1'));
  });

  it('treats the end indexes as exclusive', () => {
    expect(grid('A1:B2')).toEqual({
      sheetId: 11, startRowIndex: 0, endRowIndex: 2, startColumnIndex: 0, endColumnIndex: 2,
    });
    expect(grid('a1:c3')).toEqual({
      sheetId: 11, startRowIndex: 0, endRowIndex: 3, startColumnIndex: 0, endColumnIndex: 3,
    });
  });

  it('finds a quoted sheet title by name', () => {
    expect(grid("'My Data'!C3:D10")).toEqual({
      sheetId: 22, startRowIndex: 2, endRowIndex: 10, startColumnIndex: 2, endColumnIndex: 4,
    });
  });

  it('counts columns past Z', () => {
    expect(grid('AA5')).toEqual({
      sheetId: 11, startRowIndex: 4, endRowIndex: 5, startColumnIndex: 26, endColumnIndex: 27,
    });
  });

  it('refuses what it cannot parse or find, with an error and no sheetId', () => {
    expect(parseError('Nope!A1').error).toContain('sheet "Nope" not found');
    expect(a1ToGridRange('Nope!A1', sheets)).not.toHaveProperty('sheetId');
    for (const a1 of ['A:A', '$A$1', 'A1:']) {
      expect(parseError(a1).error).toContain('could not parse');
    }
    expect(parseError('A1', []).error).toContain('not found');
  });
});

describe('hexToRgb', () => {
  it('expands shorthand hex with or without the hash', () => {
    expect(hexToRgb('#fff')).toEqual({ red: 1, green: 1, blue: 1 });
    expect(hexToRgb('fff')).toEqual({ red: 1, green: 1, blue: 1 });
  });

  it('splits full hex into 0-1 parts, trimmed', () => {
    for (const hex of ['#FF8800', 'ff8800']) {
      const rgb = hexToRgb(hex);
      expect(rgb).not.toBeNull();
      expect(rgb!.red).toBe(1);
      expect(rgb!.green).toBeCloseTo(0.5333333333);
      expect(rgb!.blue).toBe(0);
    }
    const trimmed = hexToRgb(' #abc ');
    expect(trimmed).not.toBeNull();
    expect(trimmed!.red).toBeCloseTo(0.6666666667);
    expect(trimmed!.green).toBeCloseTo(0.7333333333);
    expect(trimmed!.blue).toBeCloseTo(0.8);
  });

  it('returns null for anything that is not 3 or 6 hex digits', () => {
    for (const hex of ['#12345', 'zz', '', 'ggg']) {
      expect(hexToRgb(hex)).toBeNull();
    }
  });
});

describe('isDateOnly', () => {
  it('accepts padded full dates and rejects the rest', () => {
    expect(isDateOnly('2026-10-26')).toBe(true);
    expect(isDateOnly(' 2026-10-26 ')).toBe(true);
    expect(isDateOnly('2026-10-26T10:00')).toBe(false);
    expect(isDateOnly('2026-1-5')).toBe(false);
  });
});

describe('hasUtcOffset', () => {
  it('reads a trailing Z or ±HH:MM, colon optional', () => {
    expect(hasUtcOffset('2026-10-26T10:00:00Z')).toBe(true);
    expect(hasUtcOffset('2026-10-26T10:00:00+05:30')).toBe(true);
    expect(hasUtcOffset('2026-10-26T10:00:00-0500')).toBe(true);
    expect(hasUtcOffset('2026-10-26T10:00:00')).toBe(false);
    expect(hasUtcOffset('2026-10-26')).toBe(false);
  });
});

describe('addOneCalendarDay', () => {
  it('advances one UTC day, crossing months, years and Feb 29', () => {
    expect(addOneCalendarDay('2026-10-26')).toBe('2026-10-27');
    expect(addOneCalendarDay('2026-12-31')).toBe('2027-01-01');
    expect(addOneCalendarDay('2028-02-28')).toBe('2028-02-29');
    expect(addOneCalendarDay('2026-02-28')).toBe('2026-03-01');
    expect(addOneCalendarDay('  2026-03-01 ')).toBe('2026-03-02');
  });
});
