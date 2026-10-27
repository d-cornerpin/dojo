import { describe, it, expect } from 'vitest';
import { normalizeCreatedAtUtc } from '../message-stamp.js';

// `normalizeCreatedAtUtc` reads one stored `created_at` — epoch-ms INTEGER (messages) or
// TEXT (deliveries) — and returns a zone-carrying ISO string, or null for an epoch-ms that
// is not finite or below the 2020-09-13 floor.

describe('epoch-ms numbers', () => {
  it('refuses an epoch-ms below the 2020-09-13 floor', () => {
    expect(normalizeCreatedAtUtc(1599999999999)).toBeNull();
  });

  it('accepts exactly the floor and renders it as a UTC ISO string', () => {
    expect(normalizeCreatedAtUtc(1600000000000)).toBe('2020-09-13T12:26:40.000Z');
  });

  it('renders a later epoch-ms as a UTC ISO string', () => {
    expect(normalizeCreatedAtUtc(1700000000000)).toBe('2023-11-14T22:13:20.000Z');
  });

  it('refuses NaN', () => {
    expect(normalizeCreatedAtUtc(Number.NaN)).toBeNull();
  });

  it('refuses positive infinity', () => {
    expect(normalizeCreatedAtUtc(Number.POSITIVE_INFINITY)).toBeNull();
  });

  it('refuses negative infinity', () => {
    expect(normalizeCreatedAtUtc(Number.NEGATIVE_INFINITY)).toBeNull();
  });
});

describe('text forms', () => {
  it('turns the first space into a T and appends Z', () => {
    expect(normalizeCreatedAtUtc('2020-09-13 12:26:40')).toBe('2020-09-13T12:26:40Z');
  });

  it('trims outer padding before normalizing', () => {
    expect(normalizeCreatedAtUtc('  2020-09-13 12:26:40  ')).toBe('2020-09-13T12:26:40Z');
  });

  it('leaves a trailing Z byte-identical (already carries a zone)', () => {
    expect(normalizeCreatedAtUtc('2020-09-13T12:26:40Z')).toBe('2020-09-13T12:26:40Z');
  });

  it('counts a +HH:MM offset as a zone, so no Z is added', () => {
    expect(normalizeCreatedAtUtc('2020-09-13T12:26:40+02:00')).toBe('2020-09-13T12:26:40+02:00');
  });

  it('counts a colon-less +HHMM offset as a zone too', () => {
    expect(normalizeCreatedAtUtc('2020-09-13T12:26:40+0200')).toBe('2020-09-13T12:26:40+0200');
  });

  it('normalizes a date at midnight', () => {
    expect(normalizeCreatedAtUtc('2021-01-01 00:00:00')).toBe('2021-01-01T00:00:00Z');
  });

  it('appends only Z when there is neither a space nor a T', () => {
    expect(normalizeCreatedAtUtc('2020-09-13')).toBe('2020-09-13Z');
  });

  it('counts a lowercase z as a zone, unchanged', () => {
    expect(normalizeCreatedAtUtc('2020-09-13T12:26:40z')).toBe('2020-09-13T12:26:40z');
  });
});
