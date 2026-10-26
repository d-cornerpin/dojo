// ── THE COERCION HELPER IS PINNED ON ITS OWN ──
// `coerceNumberArg` (agent/tools/pagination.ts:39) is the single reader every numeric tool
// arg passes through when a weak model or a provider sends the number as a JSON STRING.
// Eleven call sites across `cat/*`, `process-run.ts` and `inspect/index.ts` trust its verdict
// for offsets, limits and timeouts, yet no test named it. These pin the two branches it
// commits to — a finite number (or one a string parses to) passes, everything else is null —
// on the values measured on v35. Pure: the helper imports nothing of the server, so no mocks.

import { describe, it, expect } from 'vitest';
import { coerceNumberArg } from '../pagination.js';

describe('coerceNumberArg — a finite number passes through', () => {
  it.each([
    { label: '5', input: 5, expected: 5 },
    { label: '-3', input: -3, expected: -3 },
    { label: '0 (a real value, not "missing")', input: 0, expected: 0 },
    { label: '2.5', input: 2.5, expected: 2.5 },
  ])('$label', ({ input, expected }) => {
    expect(coerceNumberArg(input)).toBe(expected);
  });
});

describe('coerceNumberArg — a numeric string is parsed', () => {
  it.each([
    { label: "'5'", input: '5', expected: 5 },
    { label: "' 7 ' (whitespace-padded)", input: ' 7 ', expected: 7 },
    { label: "'-2'", input: '-2', expected: -2 },
    { label: "'2.5'", input: '2.5', expected: 2.5 },
  ])('$label', ({ input, expected }) => {
    expect(coerceNumberArg(input)).toBe(expected);
  });
});

describe('coerceNumberArg — an unusable string is null', () => {
  it.each([
    { label: "'' (empty)", input: '' },
    { label: "'   ' (blank)", input: '   ' },
    { label: "'abc'", input: 'abc' },
    { label: "'12px' (a unit)", input: '12px' },
    { label: "'5,000' (a thousands comma)", input: '5,000' },
  ])('$label', ({ input }) => {
    expect(coerceNumberArg(input)).toBeNull();
  });
});

describe('coerceNumberArg — a non-finite number (or its string) is null', () => {
  it.each([
    { label: 'NaN', input: NaN },
    { label: 'Infinity', input: Infinity },
    { label: '-Infinity', input: -Infinity },
    { label: "'NaN' (a string)", input: 'NaN' },
    { label: "'Infinity' (a string)", input: 'Infinity' },
  ])('$label', ({ input }) => {
    expect(coerceNumberArg(input)).toBeNull();
  });
});

describe('coerceNumberArg — any other type is null', () => {
  it.each([
    { label: 'null', input: null },
    { label: 'undefined', input: undefined },
    { label: 'true', input: true },
    { label: '[5] (an array)', input: [5] },
    { label: '{} (an object)', input: {} },
  ])('$label', ({ input }) => {
    expect(coerceNumberArg(input)).toBeNull();
  });
});
