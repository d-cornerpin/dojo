import { describe, it, expect } from 'vitest';
import { partitionForOutlook, type LocalAttachment } from '../../services/email-attachments.js';

// Every inline Outlook attachment is base64-encoded into ONE Graph request
// body, so the inline set must fit ~3MB of raw content IN TOTAL (each file
// is still capped at 3MB). Anything that doesn't fit spills to OneDrive.
const MB = 1024 * 1024;
const MAX_TOTAL = 3 * MB;

// The partition reads `size`; content only mirrors the size so the fixtures
// stand in for real files without touching the filesystem.
function att(name: string, size: number): LocalAttachment {
  return {
    path: '/x/' + name,
    name,
    size,
    mimeType: 'application/octet-stream',
    content: Buffer.alloc(size),
  };
}

function names(list: readonly LocalAttachment[]): string[] {
  return list.map((a) => a.name);
}

function totalSize(list: readonly LocalAttachment[]): number {
  return list.reduce((sum, a) => sum + a.size, 0);
}

describe('partitionForOutlook — inline attachments fit one Graph request', () => {
  const SIZE_1_2MB = Math.round(1.2 * MB);

  it('three 1.2MB files: the two that fit (2.4MB) go inline, the third spills', () => {
    const { inline, overflow } = partitionForOutlook([
      att('a', SIZE_1_2MB),
      att('b', SIZE_1_2MB),
      att('c', SIZE_1_2MB),
    ]);
    expect(inline.length).toBe(2);
    expect(overflow.length).toBe(1);
    expect(totalSize(inline)).toBe(2 * SIZE_1_2MB);
    expect(totalSize(inline)).toBeLessThanOrEqual(MAX_TOTAL);
  });

  it('a 3.5MB file spills on its own per-file size', () => {
    const { inline, overflow } = partitionForOutlook([att('big', Math.round(3.5 * MB))]);
    expect(names(inline)).toEqual([]);
    expect(names(overflow)).toEqual(['big']);
  });

  it('1MB + 1MB + 1MB (exactly 3MB total) all go inline', () => {
    const { inline, overflow } = partitionForOutlook([
      att('m1', MB),
      att('m2', MB),
      att('m3', MB),
    ]);
    expect(names(inline)).toEqual(['m1', 'm2', 'm3']);
    expect(names(overflow)).toEqual([]);
  });

  it('empty input yields two empty lists', () => {
    const { inline, overflow } = partitionForOutlook([]);
    expect(inline).toEqual([]);
    expect(overflow).toEqual([]);
  });

  it('a ten-file mix never totals over 3MB inline', () => {
    const mix = [
      att('f1', 500 * 1024),
      att('f2', 900 * 1024),
      att('f3', 300 * 1024),
      att('f4', 2 * MB),
      att('f5', 100 * 1024),
      att('f6', Math.round(1.5 * MB)),
      att('f7', 600 * 1024),
      att('f8', 40 * 1024),
      att('f9', Math.round(3.5 * MB)),
      att('f10', 800 * 1024),
    ];
    const { inline, overflow } = partitionForOutlook(mix);
    expect(totalSize(inline)).toBeLessThanOrEqual(MAX_TOTAL);
    // Every input file lands in exactly one of the two lists.
    expect([...names(inline), ...names(overflow)].sort()).toEqual([...names(mix)].sort());
  });
});
