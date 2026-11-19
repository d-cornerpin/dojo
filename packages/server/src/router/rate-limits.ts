// In-memory rate limit tracking: not persisted, resets on restart.

import { createLogger } from '../logger.js';

const logger = createLogger('rate-limits');

interface RateLimitState {
  remaining: number;
  resetAt: number;    // Unix ms
  retryAfter: number; // seconds
  lastUpdated: number;
}

const rateLimits = new Map<string, RateLimitState>();

// The retry/reset value is a count of seconds ("30", "1.5") or a Go-style duration of <number><unit>
// parts (h, m, s, ms; e.g. "1h2m3s", "250ms"). Returns seconds, or null when it is neither (e.g. "soon"
// or an HTTP date), so the caller leaves retryAfter at 0.
function parseDurationSeconds(value: string): number | null {
  const str = value.trim();
  if (str === '') return null;
  // A bare number of seconds.
  if (/^\d+(?:\.\d+)?$/.test(str)) return parseFloat(str);
  // Otherwise a duration that must tile the whole string (match ms before m).
  const unitSeconds: Record<string, number> = { ms: 0.001, m: 60, s: 1, h: 3600 };
  const partRe = /(\d+(?:\.\d+)?)(ms|m|s|h)/g;
  let total = 0;
  let sawPart = false;
  let cursor = 0;
  let part: RegExpExecArray | null;
  while ((part = partRe.exec(str)) !== null) {
    if (part.index !== cursor) return null; // a gap: not a clean duration
    cursor = partRe.lastIndex;
    sawPart = true;
    total += parseFloat(part[1]) * unitSeconds[part[2]];
  }
  return sawPart && cursor === str.length ? total : null;
}

export function updateRateLimits(modelId: string, headers: Record<string, string>): void {
  const remaining = parseInt(headers['x-ratelimit-remaining'] ?? headers['x-ratelimit-remaining-requests'] ?? headers['anthropic-ratelimit-requests-remaining'] ?? '', 10);
  const resetStr = headers['x-ratelimit-reset'] ?? headers['anthropic-ratelimit-requests-reset'] ?? '';
  const retryAfterStr = headers['retry-after'] ?? headers['x-ratelimit-reset-requests'] ?? '';

  if (isNaN(remaining) && !resetStr && !retryAfterStr) {
    return; // No rate limit headers present
  }

  let resetAt = 0;
  if (resetStr) {
    const parsed = Date.parse(resetStr);
    if (!isNaN(parsed)) {
      resetAt = parsed;
    }
  }

  let retryAfter = 0;
  if (retryAfterStr) {
    // Seconds (a bare number) or a Go-style duration like "1h2m3s"; an unrecognized value
    // leaves retryAfter at 0.
    const seconds = parseDurationSeconds(retryAfterStr);
    if (seconds !== null) {
      retryAfter = seconds;
      if (!resetAt) {
        resetAt = Date.now() + retryAfter * 1000;
      }
    }
  }

  const state: RateLimitState = {
    remaining: isNaN(remaining) ? -1 : remaining,
    resetAt,
    retryAfter,
    lastUpdated: Date.now(),
  };

  rateLimits.set(modelId, state);

  if (state.remaining >= 0 && state.remaining <= 2) {   // -1 means the count is unknown: nothing to warn about
    logger.warn('Rate limit approaching', {
      modelId,
      remaining: state.remaining,
      resetAt: new Date(resetAt).toISOString(),
    });
  }
}

export function isRateLimited(modelId: string): boolean {
  const state = rateLimits.get(modelId);
  if (!state) return false;

  // If reset time has passed, clear the limit
  if (state.resetAt > 0 && Date.now() > state.resetAt) {
    rateLimits.delete(modelId);
    return false;
  }

  // A zero-remaining record is a block only while a known reset instant is still in
  // the future. With no known reset instant there is no signal for how long it lasts,
  // so it must not block (the next real 429 records its own retry-after).
  if (state.remaining === 0 && state.resetAt > 0) {
    return true;
  }

  return false;
}

export function getRateLimitInfo(modelId: string): RateLimitState | null {
  return rateLimits.get(modelId) ?? null;
}

export function clearRateLimits(): void {
  rateLimits.clear();
}
