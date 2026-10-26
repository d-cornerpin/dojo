// t163 B — WHAT `drive_list` SENDS DRIVE AS ITS `q`, pinned directly on the two helpers.
//
// `speaksDrive` decides whether the model's text already speaks Drive (a field + operator, or a
// membership test); `driveSearchQuery` turns a bare term into `fullText contains '<term>'`,
// escaping `'` and `\` so a term can never close the string. Both are pure — no HTTP, no doubles
// — so they are measured here without the tool door.
import { describe, it, expect } from 'vitest';
import { driveSearchQuery, speaksDrive } from '../drive-query.js';

describe('driveSearchQuery — a bare term becomes a full-text search', () => {
  it('a single word is wrapped in fullText contains', () => {
    expect(driveSearchQuery('ORCHID')).toBe("fullText contains 'ORCHID'");
  });

  it('a multi-word phrase is one term, not several', () => {
    expect(driveSearchQuery('quarterly report')).toBe("fullText contains 'quarterly report'");
  });

  it('an apostrophe in the term is escaped (a term can never close the string)', () => {
    expect(driveSearchQuery("it's")).toBe("fullText contains 'it\\'s'");
  });

  it('a backslash in the term is doubled', () => {
    expect(driveSearchQuery('C:\\temp')).toBe("fullText contains 'C:\\\\temp'");
  });
});

describe('driveSearchQuery — Drive syntax passes through untouched', () => {
  it.each([
    ["name contains 'x'"],
    ["'abc' in parents"],
    ["mimeType = 'application/pdf' and trashed = false"],
    ["modifiedTime > '2026-01-01T00:00:00'"],
  ])('%s', (q) => {
    expect(driveSearchQuery(q)).toBe(q);
  });
});

describe('driveSearchQuery — no query, or only whitespace, is an empty q', () => {
  it('the empty string stays empty', () => {
    expect(driveSearchQuery('')).toBe('');
  });

  it('whitespace-only trims to an empty q', () => {
    expect(driveSearchQuery('   ')).toBe('');
  });
});

describe('speaksDrive — an operator word inside a quoted value is not Drive syntax', () => {
  it('a real operator outside the value speaks Drive', () => {
    expect(speaksDrive("fullText contains 'name = x'")).toBe(true);
  });

  it('a quoted value that merely contains an operator word does not', () => {
    expect(speaksDrive("'a name = b'")).toBe(false);
  });

  it('a plain phrase with no field or operator does not', () => {
    expect(speaksDrive('quarterly report')).toBe(false);
  });
});
