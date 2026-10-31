// A Sheets tab named with an apostrophe is written 'Bob''s Budget'!A1:B2 in A1 notation.
import { describe, it, expect, vi } from 'vitest';

vi.mock('../client.js', () => ({ googleRead: vi.fn(), googleWrite: vi.fn() }));

import { a1ToGridRange } from '../tools-write.js';

const sheets = [
  { properties: { sheetId: 11, title: 'Sheet1' } },
  { properties: { sheetId: 22, title: 'My Data' } },
  { properties: { sheetId: 33, title: "Bob's Budget" } },
];

describe('a1ToGridRange with an apostrophe in the tab name', () => {
  it('finds the tab whose name has a doubled apostrophe in the range', () => {
    expect(a1ToGridRange("'Bob''s Budget'!A1:B2", sheets)).toEqual({
      sheetId: 33, startRowIndex: 0, endRowIndex: 2, startColumnIndex: 0, endColumnIndex: 2,
    });
  });
  it('reports not found when no such tab exists', () => {
    const r = a1ToGridRange("'Bob''s Budget'!A1:B2", sheets.slice(0, 2)) as { error: string };
    expect(r.error).toContain('not found');
  });
  it('still resolves a plain quoted name', () => {
    expect(a1ToGridRange("'My Data'!A1", sheets)).toMatchObject({ sheetId: 22 });
  });
});
