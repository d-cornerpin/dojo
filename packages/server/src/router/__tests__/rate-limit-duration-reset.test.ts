// x-ratelimit-reset-requests (and retry-after) arrive as a duration, not a count of seconds.
// OpenAI sends Go-style durations like "6m0s", "1h2m3s", "250ms"; updateRateLimits used to run
// parseFloat over them, which stops at the first non-digit and reads "6m0s" as 6, "1h2m3s" as 1
// and "250ms" as 250 seconds — so a model is marked limited for a fraction of its real window and
// is retried straight into another 429. A bare number ("30", "1.5") stays seconds; anything the
// parser can't read ("soon", an HTTP date) leaves retryAfter at 0, exactly as before.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { updateRateLimits, getRateLimitInfo, clearRateLimits } from '../rate-limits.js';

function read(headers: Record<string, string>) {
  updateRateLimits('d', headers);
  return getRateLimitInfo('d')!;
}

describe('updateRateLimits reads a reset/retry value as seconds', () => {
  beforeEach(() => {
    clearRateLimits();
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('reads a minutes duration: 6m0s is 360 seconds and the matching resetAt', () => {
    const headers = { 'x-ratelimit-remaining-requests': '0', 'x-ratelimit-reset-requests': '6m0s' };
    expect(read(headers).retryAfter).toBe(360);
    expect(read(headers).resetAt).toBe(Date.now() + 360000);
  });

  it('reads hours + minutes + seconds: 1h2m3s is 3723 seconds', () => {
    expect(read({ 'x-ratelimit-remaining-requests': '0', 'x-ratelimit-reset-requests': '1h2m3s' }).retryAfter).toBe(3723);
  });

  it('reads milliseconds: 250ms is 0.25 seconds', () => {
    expect(read({ 'x-ratelimit-remaining-requests': '0', 'x-ratelimit-reset-requests': '250ms' }).retryAfter).toBe(0.25);
  });

  it('reads a decimal seconds duration: 1.5s is 1.5', () => {
    expect(read({ 'x-ratelimit-remaining-requests': '0', 'x-ratelimit-reset-requests': '1.5s' }).retryAfter).toBe(1.5);
  });

  it('reads a bare number of seconds: 30 is 30', () => {
    expect(read({ 'x-ratelimit-remaining-requests': '0', 'x-ratelimit-reset-requests': '30' }).retryAfter).toBe(30);
  });

  it('lets retry-after win over x-ratelimit-reset-requests', () => {
    expect(read({ 'retry-after': '5', 'x-ratelimit-reset-requests': '6m0s' }).retryAfter).toBe(5);
  });

  it('leaves an unrecognized value alone: "soon" gives retryAfter 0 and resetAt 0', () => {
    const info = read({ 'x-ratelimit-remaining': '3', 'x-ratelimit-reset-requests': 'soon' });
    expect(info.retryAfter).toBe(0);
    expect(info.resetAt).toBe(0);
  });
});
