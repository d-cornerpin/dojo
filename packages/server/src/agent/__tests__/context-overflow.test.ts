// The provider's own "your input is too long for my window" prose, matched by lower-cased
// substring. A leaf: the summary writer and the recovery cascade read the one predicate. A false
// negative turns a recoverable overflow into a hard failure; a false positive shrinks an unrelated
// error's input and retries it — so the boundary of "which messages count" is the thing to pin.

import { describe, it, expect } from 'vitest';
import { isContextOverflowError } from '../context-overflow.js';

// The over-length messages the providers actually send. Each is read as an overflow, and the same
// text upper-cased: the check lower-cases first, so case must not matter.
const REALISTIC = [
  'prompt is too long: 250000 tokens > 200000 maximum',
  "This model's maximum context length is 128000 tokens. However, your messages resulted in 130000 tokens.",
  'Error code: 400 - context_length_exceeded',
  'the request exceeds the context window of this model',
  'Input is too long for requested model',
  'Please reduce the length of the messages or completion.',
  'context length is 8192 tokens',
];

// Each of the nine substrings the predicate matches on, on its own and buried in a sentence.
const SUBSTRINGS = [
  'maximum context length',
  'context_length_exceeded',
  'prompt is too long',
  'context length is',
  'exceeds the context window',
  'reduce the length',
  'please reduce the length of the messages',
  'input is too long',
  'context window of',
];

// Errors that are not over-length: none of the nine substrings, so none is an overflow.
const NOT_OVERFLOW = [
  '',
  'rate limit exceeded, retry in 20 seconds',
  'invalid api key',
  'The model is overloaded',
  'connection reset by peer',
  'context deadline exceeded',
];

describe('isContextOverflowError (prose match, case-insensitive)', () => {
  for (const message of REALISTIC) {
    it(`reads the over-length message as an overflow: ${JSON.stringify(message)}`, () => {
      expect(isContextOverflowError(message)).toBe(true);
      expect(isContextOverflowError(message.toUpperCase())).toBe(true);
    });
  }

  for (const sub of SUBSTRINGS) {
    it(`matches the substring on its own: ${sub}`, () => {
      expect(isContextOverflowError(sub)).toBe(true);
    });
    it(`matches the substring buried in a sentence: ${sub}`, () => {
      expect(isContextOverflowError(`xx ${sub} yy`)).toBe(true);
    });
  }

  for (const message of NOT_OVERFLOW) {
    it(`is not an overflow: ${JSON.stringify(message)}`, () => {
      expect(isContextOverflowError(message)).toBe(false);
    });
  }
});
