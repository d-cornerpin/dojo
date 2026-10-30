// ════════════════════════════════════════════════════════════════════════════════════════
// THE 60-CHARACTER BOUNDARY HAS NO TESTS — charBoundary, pinned.
//
// `charBoundary(text, at, toward)` moves a cut point to a whole character, backward (`'back'`)
// or forward (`'forward'`): it never lands inside an emoji's two UTF-16 halves, and where a
// grapheme segmenter is available it keeps a whole grapheme — an emoji with its joiners, a
// letter with its combining accent — together. `toolResultView` uses it for BOTH ends of the
// excerpt it shows for an over-long tool result, so a wrong answer leaves a broken half-character
// in the model's context on every assembly. No test named it before this file.
//
// The expected values are MEASURED on v35. `[back, forward]` below is
// `[charBoundary(t, at, 'back'), charBoundary(t, at, 'forward')]`; a case that disagrees is kept
// out and reported, not edited to fit. Importing `charBoundary` from `../tool-result-view.js`
// loads with no mocks.
// ════════════════════════════════════════════════════════════════════════════════════════

import { describe, it, expect } from 'vitest';
import { charBoundary } from '../tool-result-view.js';

/** `[charBoundary(t, at, 'back'), charBoundary(t, at, 'forward')]` — the two ends at once. */
const pair = (t: string, at: number): [number, number] =>
  [charBoundary(t, at, 'back'), charBoundary(t, at, 'forward')];

describe('a lone emoji: the cut never splits its two halves', () => {
  const t = 'ab😀cd';   // 6 UTF-16 units; the emoji is units 2 and 3
  it('walks the units one by one', () => {
    expect(pair(t, 0)).toEqual([0, 0]);
    expect(pair(t, 1)).toEqual([1, 1]);
    expect(pair(t, 2)).toEqual([2, 2]);
    expect(pair(t, 3)).toEqual([2, 4]);   // at=3 is inside the emoji
    expect(pair(t, 4)).toEqual([4, 4]);
    expect(pair(t, 5)).toEqual([5, 5]);
  });
  it('at or past the end clamps to the end', () => {
    expect(pair(t, 6)).toEqual([6, 6]);
    expect(pair(t, 7)).toEqual([6, 6]);
  });
  it('a negative at clamps to the start', () => {
    expect(pair(t, -1)).toEqual([0, 0]);
  });
});

describe('a joined emoji (a family): the joiners stay with it', () => {
  const t = 'x👨\u200d👩\u200d👧y';   // length 10; the family is units 1 to 8
  it('holds the whole join as one grapheme, at the edges and inside it', () => {
    expect(pair(t, 1)).toEqual([1, 1]);
    for (let at = 2; at <= 8; at++) expect(pair(t, at)).toEqual([1, 9]);
    expect(pair(t, 9)).toEqual([9, 9]);
  });
  it('at or past the end clamps to the end', () => {
    expect(pair(t, 10)).toEqual([10, 10]);
  });
});

describe('a letter and its combining accent: the accent stays with the letter', () => {
  // 'é' here is the decomposed pair e + U+0301 (length 3); the precomposed é would be one unit
  // and could not orphan a combining mark, so the code points pin the decomposed form this case
  // is about — written from char codes because a literal can be normalised to the precomposed é.
  const t = String.fromCharCode(0x65, 0x301, 0x78);
  it('at the accent and past it', () => {
    expect(t.length).toBe(3);
    expect(pair(t, 1)).toEqual([0, 2]);   // at=1 is the accent, inside the é
    expect(pair(t, 2)).toEqual([2, 2]);
  });
});

describe('far past the 64-unit look-around window: the windowed scan still finds the boundary', () => {
  it('a lone emoji past the window', () => {
    const t = 'a'.repeat(300) + '😀' + 'b'.repeat(300);
    expect(charBoundary(t, 301, 'back')).toBe(300);
    expect(charBoundary(t, 301, 'forward')).toBe(302);
    expect(charBoundary(t, 300, 'back')).toBe(300);
  });
  it('a joined family past the window', () => {
    const t = 'a'.repeat(300) + '👨\u200d👩\u200d👧' + 'b'.repeat(300);
    expect(charBoundary(t, 305, 'back')).toBe(300);
    expect(charBoundary(t, 305, 'forward')).toBe(308);
  });
});

describe('property: a returned boundary is never a low surrogate, in either direction', () => {
  // The strings of the three cases above, the two long ones reaching past the 64-unit window so
  // the windowed scan is exercised near its edge. A boundary that ever lands on a low surrogate
  // (0xDC00-0xDFFF) is a half character left in the view.
  const strings = [
    'ab😀cd',
    'x👨\u200d👩\u200d👧y',
    'a'.repeat(300) + '😀' + 'b'.repeat(300),
    'a'.repeat(300) + '👨\u200d👩\u200d👧' + 'b'.repeat(300),
  ];
  const isLow = (c: number): boolean => c >= 0xdc00 && c <= 0xdfff;
  it('for every at in range and both directions', () => {
    const bad: string[] = [];
    for (const t of strings) {
      for (let at = 0; at <= t.length; at++) {
        for (const toward of ['back', 'forward'] as const) {
          const b = charBoundary(t, at, toward);
          if (isLow(t.charCodeAt(b))) bad.push(`len=${t.length} at=${at} toward=${toward} -> ${b}`);
        }
      }
    }
    expect(bad).toEqual([]);
  });
});
