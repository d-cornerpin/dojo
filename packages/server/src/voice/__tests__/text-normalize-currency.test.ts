// A dollar amount with comma-grouped thousands is spoken as one amount
// ("$1,500" → "1,500 dollars"), not split at the thousands comma into
// "1 dollars,500". Pure function — no mocks.
import { describe, it, expect } from 'vitest';
import { normalizeForSpeech } from '../text-normalize.js';

describe('normalizeForSpeech — comma-grouped dollar amounts', () => {
  it('a grouped whole-dollar amount stays together', () => {
    expect(normalizeForSpeech('It costs $1,500.')).toBe('It costs 1,500 dollars.');
  });

  it('a grouped amount with cents reads "NN dollars and NN cents"', () => {
    expect(normalizeForSpeech('Total $1,234.56 today')).toBe(
      'Total 1,234 dollars and 56 cents today',
    );
  });

  it('a large grouped amount and a zero-cents amount', () => {
    expect(normalizeForSpeech('$12,000,000 raised')).toBe('12,000,000 dollars raised');
    expect(normalizeForSpeech('$1,000.00 flat')).toBe('1,000 dollars flat');
  });

  it('plain amounts and unrelated shorthand are unaffected', () => {
    expect(normalizeForSpeech('$5')).toBe('5 dollars');
    expect(normalizeForSpeech('$5.99')).toBe('5 dollars and 99 cents');
    expect(normalizeForSpeech('$999')).toBe('999 dollars');
    // A comma followed by a space is a list comma, not a thousands separator.
    expect(normalizeForSpeech('between $5, $10 and $20')).toBe(
      'between 5 dollars, 10 dollars and 20 dollars',
    );
    expect(normalizeForSpeech('It is 72°F')).toBe('It is 72 degrees Fahrenheit');
    expect(normalizeForSpeech('3m 37s left')).toBe('3 minutes 37 seconds left');
  });
});
