// ════════════════════════════════════════════════════════════════════════════════════════
// A ZERO-REMAINING RECORD IS A BLOCK ONLY WHILE ITS RESET INSTANT IS KNOWN AND STILL FUTURE.
//
// `updateRateLimits` stores `resetAt = 0` when a success-path response carries
// `x-ratelimit-remaining: 0` with no `retry-after`, or a reset value it cannot parse
// (it only understands `Date.parse` strings; an epoch-seconds value like `1999999999`
// yields NaN). `isRateLimited` then blocks `remaining === 0` forever, because nothing
// ever expires the record — the router skips the model (`standing-filters.ts`) and a
// later 429 is the only writer. With no known reset instant there is no signal for how
// long the block lasts, so it must not block; the next real 429 records its own
// retry-after. Cases 1-2 fail today and are the fix; cases 3-5 already pass and must
// keep passing.
// ════════════════════════════════════════════════════════════════════════════════════════

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { updateRateLimits, isRateLimited, clearRateLimits } from '../rate-limits.js';

describe('a zero-remaining record blocks only while its reset instant is known and future', () => {
  beforeEach(() => {
    clearRateLimits();
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('remaining 0 with no reset signal at all does not block', () => {
    updateRateLimits('m', { 'x-ratelimit-remaining': '0' });
    expect(isRateLimited('m')).toBe(false);
  });

  it('remaining 0 with an unparseable (epoch-seconds) reset does not block', () => {
    updateRateLimits('m', { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': '1999999999' });
    expect(isRateLimited('m')).toBe(false);
  });

  it('remaining 0 with a retry-after blocks until that instant and frees after', () => {
    updateRateLimits('m', { 'x-ratelimit-remaining': '0', 'retry-after': '30' });
    expect(isRateLimited('m')).toBe(true);
    vi.advanceTimersByTime(29_000);
    expect(isRateLimited('m')).toBe(true);
    vi.advanceTimersByTime(2_000);
    expect(isRateLimited('m')).toBe(false);
  });

  it('remaining 0 with a parseable ISO reset blocks until that instant and frees after', () => {
    updateRateLimits('m', { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': '2026-01-01T00:01:00Z' });
    expect(isRateLimited('m')).toBe(true);
    vi.advanceTimersByTime(61_000);
    expect(isRateLimited('m')).toBe(false);
  });

  it('remaining > 0 never blocks, even with a retry-after present', () => {
    updateRateLimits('m', { 'x-ratelimit-remaining': '5', 'retry-after': '30' });
    expect(isRateLimited('m')).toBe(false);
  });
});
