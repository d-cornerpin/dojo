// ════════════════════════════════════════════════════════════════════════════════════════
// THE POST BUTTON'S ANSWER, READ OFF AN HTTP BODY (DOJO-REPORT T7).
//
// `parsePostChoice` is the one place the owner's click to the door's reply is translated — it
// lives beside the `PostChoice` type in `report/post.ts` so the route cannot drift from it. The
// three answers: nothing (a plain press, an ordinary post), a number (add to this existing issue),
// `true` (file separately). Everything else is REFUSED as `'invalid'`, never ignored: a misread
// answer is the owner's words landing on an issue they did not choose.
// ════════════════════════════════════════════════════════════════════════════════════════
import { describe, it, expect } from 'vitest';
import { parsePostChoice } from '../post.js';

describe('parsePostChoice', () => {
  describe('no answer is "they have not been asked" — the ordinary Post press', () => {
    it('reads null as undefined', () => {
      expect(parsePostChoice(null)).toBeUndefined();
    });
    it('reads undefined as undefined', () => {
      expect(parsePostChoice(undefined)).toBeUndefined();
    });
    it('reads an empty body as undefined', () => {
      expect(parsePostChoice({})).toBeUndefined();
    });
  });

  describe('anything that is not an object is refused, never ignored', () => {
    for (const body of ['x', 5, true, [], [1]]) {
      it(`refuses ${JSON.stringify(body)} as 'invalid'`, () => {
        expect(parsePostChoice(body)).toBe('invalid');
      });
    }
  });

  describe('adding to an existing issue names its number', () => {
    it('accepts a positive integer as an addToExisting answer', () => {
      expect(parsePostChoice({ addToExisting: 3 })).toEqual({ addToExisting: 3 });
    });
    // The number must be a positive integer — a zero, a negative, a fraction, a string, a
    // `NaN`, `null` and `undefined` are all refusals, never a number the owner did not pick.
    for (const [label, n] of [
      ['zero', 0], ['a negative', -1], ['a fraction', 1.5], ['a string', '3'],
      ['NaN', NaN], ['null', null], ['undefined', undefined],
    ] as const) {
      it(`refuses an addToExisting value that is not a positive integer as 'invalid' (${label})`, () => {
        expect(parsePostChoice({ addToExisting: n })).toBe('invalid');
      });
    }
  });

  describe('posting separately is its own answer', () => {
    it('accepts exactly true as a postSeparately answer', () => {
      expect(parsePostChoice({ postSeparately: true })).toEqual({ postSeparately: true });
    });
    for (const [label, v] of [
      ['false', false], ['the string "true"', 'true'], ['the number 1', 1],
    ] as const) {
      it(`refuses a postSeparately value that is not exactly true as 'invalid' (${label})`, () => {
        expect(parsePostChoice({ postSeparately: v })).toBe('invalid');
      });
    }
  });

  describe('more than one key, or a key it does not know, is refused', () => {
    for (const body of [
      { addToExisting: 3, postSeparately: true },
      { a: 1, b: 2 },
      { other: 1 },
      { addToExisting: 3, extra: 1 },
    ]) {
      it(`refuses ${JSON.stringify(body)} as 'invalid'`, () => {
        expect(parsePostChoice(body)).toBe('invalid');
      });
    }
  });
});
