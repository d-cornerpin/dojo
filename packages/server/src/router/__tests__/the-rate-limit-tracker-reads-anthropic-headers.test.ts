// The tracker only knew OpenAI-style header names, so Anthropic's
// `anthropic-ratelimit-requests-remaining` / `anthropic-ratelimit-requests-reset` were ignored.
// And an unknown count, stored as -1, still matched the `remaining <= 2` warning, so every
// response without a count logged "Rate limit approaching". Anthropic sends the reset as an
// RFC 3339 time, which the existing Date.parse already reads.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const warn = vi.hoisted(() => vi.fn());
vi.mock('../../logger.js', () => ({ createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn, error: vi.fn() }) }));
import { updateRateLimits, isRateLimited, getRateLimitInfo, clearRateLimits } from '../rate-limits.js';

describe('updateRateLimits reads Anthropic headers and warns only on a known low count', () => {
  beforeEach(() => {
    clearRateLimits();
    warn.mockClear();
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("Anthropic's zero remaining blocks until its reset time", () => {
    updateRateLimits('m', {
      'anthropic-ratelimit-requests-remaining': '0',
      'anthropic-ratelimit-requests-reset': '2026-01-01T00:01:00Z',
    });
    expect(isRateLimited('m')).toBe(true);
    vi.advanceTimersByTime(61_000);
    expect(isRateLimited('m')).toBe(false);
  });

  it("Anthropic's remaining count is recorded", () => {
    updateRateLimits('m', {
      'anthropic-ratelimit-requests-remaining': '5',
      'anthropic-ratelimit-requests-reset': '2026-01-01T00:01:00Z',
    });
    expect(getRateLimitInfo('m')?.remaining).toBe(5);
  });

  it('an unknown count gives no warning', () => {
    updateRateLimits('m', { 'retry-after': '30' });
    expect(warn).not.toHaveBeenCalled();
    updateRateLimits('m', { 'x-ratelimit-remaining': '1' });
    expect(warn).toHaveBeenCalledTimes(1);
  });
});
