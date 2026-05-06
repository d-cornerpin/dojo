import { describe, it, expect } from 'vitest';
import { classifyRecoverableProviderError } from '../classifiers/provider.js';

describe('classifyRecoverableProviderError', () => {
  it('returns null for empty string', () => {
    expect(classifyRecoverableProviderError('')).toBeNull();
  });

  it('returns null for rate-limit errors', () => {
    expect(classifyRecoverableProviderError('429 rate_limit_exceeded')).toBeNull();
    expect(classifyRecoverableProviderError('Anthropic API: rate limit')).toBeNull();
    expect(classifyRecoverableProviderError('overloaded_error 529')).toBeNull();
  });

  it('returns null for network/transient errors', () => {
    expect(classifyRecoverableProviderError('ECONNREFUSED 127.0.0.1:11434')).toBeNull();
    expect(classifyRecoverableProviderError('socket hang up')).toBeNull();
    expect(classifyRecoverableProviderError('fetch failed: timeout after 30s')).toBeNull();
    expect(classifyRecoverableProviderError('500 Internal Server Error')).toBeNull();
  });

  it('returns null for auth errors', () => {
    expect(classifyRecoverableProviderError('401 Unauthorized')).toBeNull();
    expect(classifyRecoverableProviderError('invalid_api_key')).toBeNull();
  });

  it('classifies vision mismatch (404 no endpoints found)', () => {
    const r = classifyRecoverableProviderError('404 No endpoints found that support image input');
    expect(r).not.toBeNull();
    expect(r!.kind).toBe('vision_mismatch');
  });

  it('classifies vision mismatch ("does not support vision")', () => {
    const r = classifyRecoverableProviderError('400 Bad Request: this model does not support vision');
    expect(r).not.toBeNull();
    expect(r!.kind).toBe('vision_mismatch');
  });

  it('classifies vision mismatch ("cannot handle image_url")', () => {
    const r = classifyRecoverableProviderError("Cannot handle image_url block");
    expect(r).not.toBeNull();
    expect(r!.kind).toBe('vision_mismatch');
  });

  it('classifies unsupported_modality for audio', () => {
    const r = classifyRecoverableProviderError('400 unsupported modality: audio');
    expect(r).not.toBeNull();
    expect(r!.kind).toBe('unsupported_modality');
  });

  it('classifies tool_format_rejected for invalid tool_use', () => {
    const r = classifyRecoverableProviderError('400 tool_use block has invalid input');
    expect(r).not.toBeNull();
    expect(r!.kind).toBe('tool_format_rejected');
  });

  it('classifies tool_format_rejected for tool_use_id not found', () => {
    const r = classifyRecoverableProviderError("tool_calls reference tool_use_id that does not match");
    expect(r).not.toBeNull();
    expect(r!.kind).toBe('tool_format_rejected');
  });

  it('classifies malformed_request for generic 400 with specificity', () => {
    const r = classifyRecoverableProviderError('400 invalid_request_error: unrecognized field');
    expect(r).not.toBeNull();
    expect(r!.kind).toBe('malformed_request');
  });

  it('returns null for vague 400 (avoids over-classification)', () => {
    const r = classifyRecoverableProviderError('400 Bad Request');
    // No "not support" / "invalid_request_error" / "malformed" / "unrecognized" keyword
    expect(r).toBeNull();
  });

  it('returns null for unrecognized error types', () => {
    expect(classifyRecoverableProviderError('Some completely unknown error message')).toBeNull();
  });

  it('every classification returns userFacingReason and guidance', () => {
    const errors = [
      '404 No endpoints found that support image input',
      '400 unsupported modality: audio',
      '400 tool_use invalid',
      '400 invalid_request_error: unrecognized',
      '404 does not support',
    ];
    for (const err of errors) {
      const r = classifyRecoverableProviderError(err);
      expect(r).not.toBeNull();
      expect(r!.userFacingReason.length).toBeGreaterThan(0);
      expect(r!.guidance.length).toBeGreaterThan(0);
    }
  });
});
