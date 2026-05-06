import { describe, it, expect } from 'vitest';
import { errorRecoveryClassifier } from '../classifiers/errors.js';

describe('errorRecoveryClassifier', () => {
  it('classifies rate_limit', () => {
    expect(errorRecoveryClassifier('429 Too Many Requests').kind).toBe('rate_limit');
    expect(errorRecoveryClassifier('rate_limit_exceeded').kind).toBe('rate_limit');
  });

  it('classifies overloaded', () => {
    expect(errorRecoveryClassifier('overloaded_error 529').kind).toBe('overloaded');
  });

  it('classifies auth', () => {
    expect(errorRecoveryClassifier('401 Unauthorized').kind).toBe('auth');
    expect(errorRecoveryClassifier('invalid_api_key').kind).toBe('auth');
  });

  it('classifies network errors', () => {
    expect(errorRecoveryClassifier('ECONNREFUSED').kind).toBe('network');
    expect(errorRecoveryClassifier('socket hang up').kind).toBe('network');
    expect(errorRecoveryClassifier('500 Internal Server Error').kind).toBe('network');
    expect(errorRecoveryClassifier('request timeout after 30s').kind).toBe('network');
  });

  it('classifies context overflow', () => {
    expect(errorRecoveryClassifier('prompt is too long').kind).toBe('context_overflow');
    expect(errorRecoveryClassifier('context window exceeded').kind).toBe('context_overflow');
    expect(errorRecoveryClassifier('context_length_exceeded').kind).toBe('context_overflow');
  });

  it('classifies output truncation', () => {
    expect(errorRecoveryClassifier('max_output_tokens reached').kind).toBe('output_truncated');
    expect(errorRecoveryClassifier('output truncated').kind).toBe('output_truncated');
  });

  it('classifies tool crashes', () => {
    expect(errorRecoveryClassifier('tool crashed unexpectedly').kind).toBe('tool_crash');
    expect(errorRecoveryClassifier('tool timed out after 30s').kind).toBe('tool_crash');
  });

  it('delegates to provider classifier for vision_mismatch', () => {
    const r = errorRecoveryClassifier('404 No endpoints found that support image input');
    expect(r.kind).toBe('vision_mismatch');
    expect(r.guidance).toBeDefined();
  });

  it('delegates to provider classifier for tool_format_rejected', () => {
    const r = errorRecoveryClassifier('400 tool_use block has invalid input');
    expect(r.kind).toBe('tool_format_rejected');
    expect(r.guidance).toBeDefined();
  });

  it('returns unknown for unrecognized errors', () => {
    const r = errorRecoveryClassifier('something completely random');
    expect(r.kind).toBe('unknown');
  });

  it('handles empty error', () => {
    expect(errorRecoveryClassifier('').kind).toBe('unknown');
  });

  it('handles Error objects', () => {
    const r = errorRecoveryClassifier(new Error('429 rate limit'));
    expect(r.kind).toBe('rate_limit');
  });
});
