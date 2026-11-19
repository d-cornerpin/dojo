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
  it('counts from 1', () => {
    expect(normalizePageList([1, 2], 3)).toEqual([0, 1]);
  });

  it('the last page is the total', () => {
    expect(normalizePageList([3], 3)).toEqual([2]);
  });

  it('0 is not a page', () => {
    expect(normalizePageList([0], 3)).toEqual([]);
  });

  it('a page past the end is dropped', () => {
    expect(normalizePageList([4], 3)).toEqual([]);
  });

  it('negatives and fractions are dropped', () => {
    expect(normalizePageList([-1, 1.5, 2], 3)).toEqual([1]);
  });

  it('an empty list is empty', () => {
    expect(normalizePageList([], 3)).toEqual([]);
    expect(normalizePageList(undefined, 3)).toEqual([]);
  });
});
