// PHASE-4 T5 Step 1 — M7: THE ONE PATCH RULE, pinned at its source.
//
//   `undefined`  =  LEAVE THIS FIELD ALONE.  (the key is dropped; nothing is emitted)
//   `null`       =  CLEAR / REMOVE THIS FIELD.
//
// `patch-undefined.test.ts` pins this rule at the SITES that build `UPDATE ... SET`
// from it. These three helpers are the one place that rule lives, so their own
// contract needs its own pins: a later edit that flips "undefined means drop" into
// "undefined means write" would silently erase columns at every door.

import { describe, it, expect } from 'vitest';
import { patchedKeys, patchAssignments, mergeObjectPatch } from '../patch.js';

describe('patchedKeys', () => {
  it('drops the undefined keys and keeps the falsy-but-defined ones, in order', () => {
    expect(
      patchedKeys({ a: 1, b: undefined, c: null, d: false, e: 0, f: '' }),
    ).toEqual(['a', 'c', 'd', 'e', 'f']);
  });

  it('an empty patch mentions nothing', () => {
    expect(patchedKeys({})).toEqual([]);
  });
});

describe('patchAssignments', () => {
  it('emits a `col = ?` and its value for every mentioned key, dropping the undefined ones', () => {
    expect(
      patchAssignments({ title: 'x', note: null, skipped: undefined }),
    ).toEqual({ sets: ['title = ?', 'note = ?'], values: ['x', null] });
  });

  it('a key whose column maps to undefined is dropped', () => {
    expect(
      patchAssignments(
        { a: 1, b: 2, c: 3 },
        { column: (k) => (k === 'b' ? undefined : 'col_' + k) },
      ),
    ).toEqual({ sets: ['col_a = ?', 'col_c = ?'], values: [1, 3] });
  });

  it('the encoder never sees undefined, and sees null', () => {
    expect(
      patchAssignments(
        { a: 1, b: null },
        { encode: (k, v) => (v === null ? 'null-' + k : v) },
      ),
    ).toEqual({ sets: ['a = ?', 'b = ?'], values: [1, 'null-b'] });
  });

  it('a patch that mentions nothing assigns nothing', () => {
    expect(patchAssignments({})).toEqual({ sets: [], values: [] });
  });
});

describe('mergeObjectPatch', () => {
  it('leaves an undefined key alone, removes a null key, and replaces a set one', () => {
    expect(
      mergeObjectPatch({ a: 1, b: 2, c: 3 }, { a: undefined, b: null, d: 4 }),
    ).toEqual({ a: 1, c: 3, d: 4 });
  });

  it('does not modify the base object it was given', () => {
    const base: Record<string, unknown> = { a: 1, b: 2, c: 3 };
    const baseCopy = { ...base };
    mergeObjectPatch(base, { a: undefined, b: null, d: 4 });
    expect(base).toEqual(baseCopy);
  });
});
