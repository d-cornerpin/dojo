// editDistance — the Levenshtein distance (fewest single-character
// insert/delete/substitute steps that turn one string into the other) that
// scores a mistyped tool name against the real ones.
// It walks UTF-16 code units, not code points: astral pairs that share a high
// surrogate can count lower than a human sees, so astral inputs are kept out.
import { describe, it, expect } from 'vitest';
import { editDistance } from '../name-help.js';

describe('editDistance', () => {
  it('the empty string costs every character of the other', () => {
    expect(editDistance('', '')).toBe(0);
    expect(editDistance('a', '')).toBe(1);
    expect(editDistance('', 'abc')).toBe(3);
  });

  it('a string is zero edits from itself', () => {
    expect(editDistance('abc', 'abc')).toBe(0);
    expect(editDistance('gmail_search', 'gmail_search')).toBe(0);
  });

  it('the classic pair, and the distance is symmetric', () => {
    expect(editDistance('kitten', 'sitting')).toBe(3);
    expect(editDistance('sitting', 'kitten')).toBe(3);
  });

  it('a differing case is one substitution — the distance is not case-folded', () => {
    expect(editDistance('a', 'A')).toBe(1);
  });

  it('a transposition costs two: there is no swap operation', () => {
    expect(editDistance('ab', 'ba')).toBe(2);
  });

  it('flaw to lawn, and saturday to sunday', () => {
    expect(editDistance('flaw', 'lawn')).toBe(2);
    expect(editDistance('saturday', 'sunday')).toBe(3);
  });
});
