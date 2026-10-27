// `nonNeg`: a count/millis/bytes/ordinal coercer. A finite, non-negative number
// passes through unchanged; anything else — negative, non-finite, or not a
// number — is not a measurement and comes out `null`.
import { describe, it, expect } from 'vitest';
import { nonNeg } from '../telemetry-coerce.js';

describe('nonNeg', () => {
  it('passes a positive integer through unchanged', () => {
    expect(nonNeg(42)).toBe(42);
  });

  it('passes zero through unchanged', () => {
    expect(nonNeg(0)).toBe(0);
  });

  it('passes negative zero through as negative zero', () => {
    // -0 is not treated as negative: it passes and is returned as -0 (JSON: 0).
    expect(Object.is(nonNeg(-0), -0)).toBe(true);
  });

  it('passes a finite positive float through unchanged', () => {
    expect(nonNeg(3.14159)).toBe(3.14159);
  });

  it('rejects a negative number', () => {
    expect(nonNeg(-1)).toBeNull();
  });

  it('rejects null', () => {
    expect(nonNeg(null)).toBeNull();
  });

  it('rejects undefined', () => {
    expect(nonNeg(undefined)).toBeNull();
  });

  it('rejects NaN', () => {
    expect(nonNeg(NaN)).toBeNull();
  });

  it('rejects positive Infinity', () => {
    expect(nonNeg(Infinity)).toBeNull();
  });

  it('rejects negative Infinity', () => {
    expect(nonNeg(-Infinity)).toBeNull();
  });

  it('passes the largest safe integer through unchanged', () => {
    expect(nonNeg(Number.MAX_SAFE_INTEGER)).toBe(9007199254740991);
  });

  it('passes a finite value beyond the safe-integer range through unchanged', () => {
    expect(nonNeg(1e300)).toBe(1e300);
  });
});
