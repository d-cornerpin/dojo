// formatSize picks the unit from the ROUNDED value, so a size that rounds up to
// 1024 KB prints as "1MB" — never the impossible "1024KB" it produced before
// rounding. The MB branch keeps one decimal, as today (4404019 → "4.2MB").
import { describe, it, expect } from 'vitest';
import { formatSize, guessMimeType } from '../email-attachments.js';

describe('formatSize', () => {
  it.each([
    [0, '0B'],
    [1023, '1023B'],
    [1024, '1KB'],
    [1536, '2KB'],
    [1048575, '1MB'],   // one byte under 1 MB rounds up to a whole MB, not "1024KB"
    [1048576, '1MB'],
    [4404019, '4.2MB'],
  ])('%i bytes prints %s', (bytes, expected) => {
    expect(formatSize(bytes)).toBe(expected);
  });
});

describe('guessMimeType — characterization', () => {
  it('a .PDF extension is case-insensitively application/pdf', () => {
    expect(guessMimeType('a.PDF')).toBe('application/pdf');
  });
  it('no extension falls back to application/octet-stream', () => {
    expect(guessMimeType('noext')).toBe('application/octet-stream');
  });
});
