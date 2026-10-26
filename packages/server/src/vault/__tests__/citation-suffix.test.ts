// ════════════════════════════════════════
// formatCitationSuffix: the [source: …] tail the recall tools append to a
// vault entry. It is pure — it only ever sees the stored citation column, a
// string that may be NULL, non-JSON, or the wrong shape — so it is imported
// straight from the store and tested without a database.
//
// It must degrade to '' on any junk so callers can append unconditionally, and
// render a compact source for a well-formed citation: a file path collapses to
// its last segment, a section is trimmed, a finite page shows even at 0.
// ════════════════════════════════════════

import { describe, it, expect } from 'vitest';

import { formatCitationSuffix } from '../store.js';

describe('formatCitationSuffix — a junk or missing column is an empty suffix', () => {
  it('returns "" for null, undefined, and the empty string', () => {
    expect(formatCitationSuffix(null)).toBe('');
    expect(formatCitationSuffix(undefined)).toBe('');
    expect(formatCitationSuffix('')).toBe('');
  });

  it('returns "" for a column that is not JSON', () => {
    expect(formatCitationSuffix('not json')).toBe('');
  });

  it('returns "" for JSON that parses to null', () => {
    expect(formatCitationSuffix('null')).toBe('');
  });

  it('returns "" for JSON with no ref at all', () => {
    expect(formatCitationSuffix('{}')).toBe('');
  });

  it('returns "" for a ref that is the empty string', () => {
    expect(formatCitationSuffix(JSON.stringify({ kind: 'file', ref: '' }))).toBe('');
  });

  it('returns "" for a ref that is not a string', () => {
    expect(formatCitationSuffix(JSON.stringify({ ref: 5 }))).toBe('');
  });
});

describe('formatCitationSuffix — a well-formed citation renders a compact source', () => {
  it('collapses a file path to its last segment and trims the section', () => {
    expect(
      formatCitationSuffix(
        JSON.stringify({ kind: 'file', ref: '/home/x/docs/report.pdf', page: 3, section: ' Intro ' }),
      ),
    ).toBe(' [source: report.pdf p.3 (Intro)]');
  });

  it('collapses a backslash (Windows) path the same way', () => {
    expect(
      formatCitationSuffix(JSON.stringify({ kind: 'file', ref: 'C:\\docs\\plan.docx' })),
    ).toBe(' [source: plan.docx]');
  });

  it('leaves a URL whole, and drops a non-number page and a blank section', () => {
    expect(
      formatCitationSuffix(
        JSON.stringify({ kind: 'url', ref: 'https://a.example/b/c', page: null, section: '   ' }),
      ),
    ).toBe(' [source: https://a.example/b/c]');
  });

  it('shows page 0, which is a real number', () => {
    expect(
      formatCitationSuffix(JSON.stringify({ kind: 'url', ref: 'https://a.example/b', page: 0 })),
    ).toBe(' [source: https://a.example/b p.0]');
  });
});
