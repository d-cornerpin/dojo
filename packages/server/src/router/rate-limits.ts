// ════════════════════════════════════════
// In-Memory Rate Limit Tracking
// NOT persisted. Resets on restart.
// ════════════════════════════════════════

import { createLogger } from '../logger.js';

const logger = createLogger('rate-limits');

interface RateLimitState {
  remaining: number;
  resetAt: number;    // Unix ms
  retryAfter: number; // seconds
  lastUpdated: number;
}

const rateLimits = new Map<string, RateLimitState>();

export function updateRateLimits(modelId: string, headers: Record<string, string>): void {
  const remaining = parseInt(headers['x-ratelimit-remaining'] ?? headers['x-ratelimit-remaining-requests'] ?? '', 10);
  const resetStr = headers['x-ratelimit-reset'] ?? '';
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
    // Could be seconds or a duration string like "1s" or "30s"
    const numeric = parseFloat(retryAfterStr);
    if (!isNaN(numeric)) {
      retryAfter = numeric;
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

  if (state.remaining === 0 || state.remaining <= 2) {
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

  // If remaining is 0, we're rate limited
  if (state.remaining === 0) {
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
