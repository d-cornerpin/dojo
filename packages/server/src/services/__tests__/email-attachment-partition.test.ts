import { describe, it, expect } from 'vitest';
import {
  partitionForGmail,
  partitionForOutlook,
  guessMimeType,
  currentMonthFolderName,
  type LocalAttachment,
} from '../email-attachments.js';

// The partition helpers decide which outgoing attachments ride inline and which
// spill to Drive/OneDrive. v35 shipped these with no coverage, so these lock in
// the documented policies: Gmail's 25MB combined cap packed smallest-first,
// Outlook's 3MB per-file cap, and the extension→MIME lookup.
const MB = 1024 * 1024;

// Partition reads only `size`, mime-guess reads only `name`, so a zero-length
// content buffer and a placeholder mime type stand in for real files without
// touching the filesystem.
function att(name: string, size: number): LocalAttachment {
  return { path: '/x/' + name, name, size, mimeType: 'x', content: Buffer.alloc(0) };
}

function names(list: readonly LocalAttachment[]): string[] {
  return list.map((a) => a.name);
}

describe('guessMimeType — extension lookup is case-insensitive, final-extension-only', () => {
  it('maps .PDF to application/pdf', () => {
    expect(guessMimeType('Report.PDF')).toBe('application/pdf');
  });
  it('maps .JPeG to image/jpeg', () => {
    expect(guessMimeType('pic.JPeG')).toBe('image/jpeg');
  });
  it('uses only the final extension (.tar.gz -> .gz)', () => {
    expect(guessMimeType('a.tar.gz')).toBe('application/gzip');
  });
  it('maps .docx to the Office Open XML word type', () => {
    expect(guessMimeType('x.docx')).toBe(
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    );
  });
  it('falls back to octet-stream when there is no extension', () => {
    expect(guessMimeType('noext')).toBe('application/octet-stream');
  });
  it('falls back to octet-stream for a dotfile like .gitignore', () => {
    expect(guessMimeType('.gitignore')).toBe('application/octet-stream');
  });
  it('falls back to octet-stream for an unlisted extension', () => {
    expect(guessMimeType('a.unknownext')).toBe('application/octet-stream');
  });
});

describe('partitionForGmail — 25MB combined cap, packed smallest-first', () => {
  it('empty input yields empty inline and overflow', () => {
    const { inline, overflow } = partitionForGmail([]);
    expect(names(inline)).toEqual([]);
    expect(names(overflow)).toEqual([]);
  });

  it('packs the smallest files inline first and spills the rest to overflow', () => {
    const { inline, overflow } = partitionForGmail([
      att('big', 20 * MB),
      att('s1', 3 * MB),
      att('s2', 4 * MB),
      att('huge', 26 * MB),
      att('s3', 1 * MB),
    ]);
    // Inline order is smallest-first: s3 (1MB), s1 (3MB), s2 (4MB).
    expect(names(inline)).toEqual(['s3', 's1', 's2']);
    // 26MB never fits the 25MB cap; 20MB overflows it after the small ones fit.
    expect(names(overflow).sort()).toEqual(['big', 'huge']);
  });

  it('a file larger than the 25MB cap overflows on its own', () => {
    const { inline, overflow } = partitionForGmail([att('huge', 26 * MB)]);
    expect(names(inline)).toEqual([]);
    expect(names(overflow)).toEqual(['huge']);
  });

  it('smallest-first lets a 1-byte file go inline even when a 25MB file cannot', () => {
    const { inline, overflow } = partitionForGmail([att('e1', 25 * MB), att('e2', 1)]);
    expect(names(inline)).toEqual(['e2']);
    expect(names(overflow)).toEqual(['e1']);
  });

  it('every input lands in exactly one of inline or overflow', () => {
    const { inline, overflow } = partitionForGmail([
      att('a', 10 * MB),
      att('b', 10 * MB),
      att('c', 10 * MB),
      att('d', 1),
    ]);
    expect([...names(inline), ...names(overflow)].sort()).toEqual(['a', 'b', 'c', 'd']);
  });
});

describe('partitionForOutlook — 3MB per-file cap, input order kept', () => {
  it('spills only the per-file overage and keeps input order', () => {
    const { inline, overflow } = partitionForOutlook([
      att('a', 2 * MB),
      att('b', 4 * MB),
      att('c', 1),
    ]);
    expect(names(inline)).toEqual(['a', 'c']);
    expect(names(overflow)).toEqual(['b']);
  });
});

describe('currentMonthFolderName — YYYY-MM folder name', () => {
  it('matches the YYYY-MM shape', () => {
    expect(currentMonthFolderName()).toMatch(/^\d{4}-(0[1-9]|1[0-2])$/);
  });
});
