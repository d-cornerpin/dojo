import { describe, it, expect } from 'vitest';
import {
  classifyRecoverableProviderError,
  classifyPlatformError,
} from '../classifiers/provider.js';

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

  // ── v2.3.19 (error-handling-spec Phase 1) — new Tier B branches ──

  it('classifies image_too_large_post_sips (the real Anthropic error string)', () => {
    const r = classifyRecoverableProviderError(
      '400 invalid_request_error: messages.2.content.1.image.source.base64: image exceeds 5 MB maximum: 5595668 bytes > 5242880 bytes',
    );
    expect(r).not.toBeNull();
    expect(r!.kind).toBe('image_too_large_post_sips');
  });

  it('classifies image_too_many (request had too many images)', () => {
    const r = classifyRecoverableProviderError(
      '400 invalid_request_error: too many images in request — maximum is 100',
    );
    expect(r).not.toBeNull();
    expect(r!.kind).toBe('image_too_many');
  });

  it('classifies tool_name_unknown for unknown tool reference', () => {
    const r = classifyRecoverableProviderError(
      '400 invalid_request_error: tool "memry_save" does not exist',
    );
    expect(r).not.toBeNull();
    expect(r!.kind).toBe('tool_name_unknown');
  });

  it('classifies tool_args_invalid_json', () => {
    const r = classifyRecoverableProviderError(
      '400 invalid_request_error: tool arguments invalid json: unexpected token',
    );
    expect(r).not.toBeNull();
    expect(r!.kind).toBe('tool_args_invalid_json');
  });

  it('classifies tool_args_schema_mismatch', () => {
    const r = classifyRecoverableProviderError(
      '400 invalid_request_error: tool arguments schema validation failed: required field missing',
    );
    expect(r).not.toBeNull();
    expect(r!.kind).toBe('tool_args_schema_mismatch');
  });

  it('classifies refusal (content policy / safety)', () => {
    const r = classifyRecoverableProviderError(
      'content_filter: model refused to respond due to safety policy',
    );
    expect(r).not.toBeNull();
    expect(r!.kind).toBe('refusal');
  });

  it('classifies provider_garbage for malformed response', () => {
    const r = classifyRecoverableProviderError(
      'parse error: truncated json in response body',
    );
    expect(r).not.toBeNull();
    expect(r!.kind).toBe('provider_garbage');
  });

  it('image_too_large is preferred over generic malformed_request', () => {
    // Both branches could match. Specific should win.
    const r = classifyRecoverableProviderError(
      '400 invalid_request_error: image.source.base64 exceeds 5 MB maximum',
    );
    expect(r).not.toBeNull();
    expect(r!.kind).toBe('image_too_large_post_sips');
  });
});

describe('classifyPlatformError (Tier D)', () => {
  it('returns null for empty', () => {
    expect(classifyPlatformError('')).toBeNull();
  });

  it('classifies auth_invalid for 401', () => {
    expect(classifyPlatformError('401 Unauthorized')!.kind).toBe('auth_invalid');
    expect(classifyPlatformError('invalid_api_key')!.kind).toBe('auth_invalid');
    expect(classifyPlatformError('API key expired')!.kind).toBe('auth_invalid');
  });

  it('classifies access_denied for 403', () => {
    expect(classifyPlatformError('403 Forbidden')!.kind).toBe('access_denied');
  });

  it('classifies quota_exhausted (distinct from rate limit)', () => {
    expect(classifyPlatformError('quota exceeded for the day')!.kind).toBe('quota_exhausted');
    expect(classifyPlatformError('insufficient_quota')!.kind).toBe('quota_exhausted');
  });

  it('classifies dns_failure for ENOTFOUND', () => {
    expect(classifyPlatformError('getaddrinfo ENOTFOUND api.anthropic.com')!.kind).toBe('dns_failure');
  });

  it('returns null for ordinary 4xx (those are Tier B recoverable errors)', () => {
    expect(classifyPlatformError('400 invalid_request_error: bad image')).toBeNull();
    expect(classifyPlatformError('404 model not found')).toBeNull();
  });
});
