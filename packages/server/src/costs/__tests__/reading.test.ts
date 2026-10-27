// `reading` is the single gate that decides whether a stored chars-per-token column counts as a
// divisor: positive and finite, else null. Its caller (`measuredDivisorsFor`) is covered against
// the DB, but the gate itself was unnamed, so it is exercised here at its own boundary.

import { describe, it, expect } from 'vitest';
import { reading } from '../estimator-divisors.js';

describe('reading', () => {
  it('a positive finite integer reads as itself', () => {
    expect(reading(42)).toBe(42);
  });

  it('a positive finite fraction reads as itself', () => {
    expect(reading(3.5)).toBe(3.5);
  });

  it('zero reads as null', () => {
    expect(reading(0)).toBeNull();
  });

  it('a negative number reads as null', () => {
    expect(reading(-2)).toBeNull();
  });

  it('NaN reads as null', () => {
    expect(reading(NaN)).toBeNull();
  });

  it('Infinity reads as null', () => {
    expect(reading(Infinity)).toBeNull();
  });

  it('a numeric string reads as null', () => {
    expect(reading('42')).toBeNull();
  });

  it('null reads as null', () => {
    expect(reading(null)).toBeNull();
  });

  it('undefined reads as null', () => {
    expect(reading(undefined)).toBeNull();
  });

  it('an object reads as null', () => {
    expect(reading({})).toBeNull();
  });
});
