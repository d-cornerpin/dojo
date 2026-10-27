import { describe, it, expect } from 'vitest';
import { wrapText, alignX, normalizePageList } from '../pdf-tools.js';

// Every character is exactly `size` wide, so a line's width is its
// character count times the size. That makes the wrap boundaries
// computable by hand without a real font.
const font = {
  widthOfTextAtSize: (s: string, size: number) => s.length * size,
};

describe('wrapText', () => {
  it('an empty paragraph is one empty line', () => {
    expect(wrapText('', font, 1, 10)).toEqual(['']);
  });

  it('breaks words onto the next line when they no longer fit', () => {
    expect(wrapText('aaa bbb ccc', font, 1, 7)).toEqual(['aaa bbb', 'ccc']);
  });

  it('one word per line when the line is as wide as a word', () => {
    expect(wrapText('aaa bbb ccc', font, 1, 3)).toEqual(['aaa', 'bbb', 'ccc']);
  });

  it('a larger size fills the same line with fewer words', () => {
    expect(wrapText('aaa bbb', font, 2, 6)).toEqual(['aaa', 'bbb']);
  });

  it('cuts a word wider than the line character by character', () => {
    expect(wrapText('abcdefghij', font, 1, 4)).toEqual(['abcd', 'efgh', 'ij']);
  });

  it('mixes word wrapping and per-character breaks in one paragraph', () => {
    expect(wrapText('ab cdefghij k', font, 1, 4)).toEqual(['ab', 'cdef', 'ghij', 'k']);
  });

  it('keeps hard line breaks, including a blank line', () => {
    expect(wrapText('hi\n\nthere you', font, 1, 20)).toEqual(['hi', '', 'there you']);
  });
});

describe('alignX', () => {
  // contentLeft 10, contentWidth 100, lineWidth 40.
  it('left aligns to the content edge', () => {
    expect(alignX('left', 40, 10, 100)).toBe(10);
  });

  it('centre aligns in the middle of the content', () => {
    expect(alignX('center', 40, 10, 100)).toBe(40);
  });

  it('right aligns to the far edge', () => {
    expect(alignX('right', 40, 10, 100)).toBe(70);
  });

  it('an undefined alignment falls back to the left edge', () => {
    expect(alignX(undefined, 40, 10, 100)).toBe(10);
  });
});

describe('normalizePageList', () => {
  it('keeps 0-based indexes that are all in range', () => {
    expect(normalizePageList([0, 1], 3)).toEqual([0, 1]);
  });

  it('reads a page equal to the total as 1-based', () => {
    expect(normalizePageList([1, 2, 3], 3)).toEqual([0, 1, 2]);
  });

  it('drops indexes out of range after the 1-based shift', () => {
    expect(normalizePageList([3], 3)).toEqual([2]);
  });

  it('an index past the end leaves nothing', () => {
    expect(normalizePageList([4], 3)).toEqual([]);
  });

  it('drops negative indexes', () => {
    expect(normalizePageList([-1, 2], 3)).toEqual([2]);
  });

  it('a 1-based list keeps only the in-range pages', () => {
    expect(normalizePageList([3, 5], 3)).toEqual([2]);
  });

  it('an empty list is empty', () => {
    expect(normalizePageList([], 3)).toEqual([]);
  });

  it('no input is empty', () => {
    expect(normalizePageList(undefined, 3)).toEqual([]);
  });

  it('a single-page file: 1-based [1] and 0-based [0] both land on page 0', () => {
    expect(normalizePageList([1], 1)).toEqual([0]);
    expect(normalizePageList([0], 1)).toEqual([0]);
  });
});
