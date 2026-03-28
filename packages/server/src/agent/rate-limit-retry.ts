// ════════════════════════════════════════
// Rate Limit Retry Manager
//
// Three-strike approach:
//   Strike 1: Transient blip. Retry silently after 10 seconds. No alert.
//   Strike 2: Might be real. Retry after 30 seconds. Still no alert.
//   Strike 3: It's real. Alert the owner, set status to rate_limited,
//             start the decay schedule: 1m, 5m, 30m, 1h, 2h, 3h, 4h, 5h
//   After 5h: Critical alert — something else is probably wrong.
//
// If a retry-after header is present, use its exact value instead.
// ════════════════════════════════════════

import { v4 as uuidv4 } from 'uuid';
import { createLogger } from '../logger.js';
import { broadcast } from '../gateway/ws.js';
import { sendAlert } from '../services/imessage-bridge.js';
import { getDb } from '../db/connection.js';
import { isPrimaryAgent } from '../config/platform.js';
import { notifyRateLimitHit } from './errors.js';

const logger = createLogger('rate-limit-retry');

// Silent retry delays for strikes 1 and 2 (seconds)
const SILENT_RETRIES = [10, 30];

// Decay schedule for strike 3+ (seconds)
const DECAY_SCHEDULE_SECONDS = [
  60,       // 1 minute
  300,      // 5 minutes
  1800,     // 30 minutes
  3600,     // 1 hour
  7200,     // 2 hours
  10800,    // 3 hours
  14400,    // 4 hours
  18000,    // 5 hours
];

interface RetryState {
  agentId: string;
  timer: ReturnType<typeof setTimeout>;
  strike: number;        // 0-indexed: 0 = first silent, 1 = second silent, 2+ = decay schedule
  startedAt: number;
  lastMessageContent: string | null;
  alerted: boolean;      // whether the owner has been notified
}

const retryStates = new Map<string, RetryState>();

/**
 * Handle a rate limit or overloaded error for an agent.
 * Called from the model layer when the API returns 429/529.
 */
export function scheduleRateLimitRetry(
  agentId: string,
  retryAfterSeconds: number | null,
  lastMessageContent: string | null,
): void {
  // If already retrying, don't stack
  if (retryStates.has(agentId)) {
    logger.debug('Rate limit retry already active, ignoring duplicate', { agentId });
    return;
  }

  const strike = 0;
  const startedAt = Date.now();

  // If we have an exact retry-after, use it (skip silent retries)
  const waitSeconds = retryAfterSeconds !== null && retryAfterSeconds > 0
    ? retryAfterSeconds
    : SILENT_RETRIES[0];

  const agentName = getAgentName(agentId);
  logger.info(`Rate limit hit for ${agentName}, silent retry in ${waitSeconds}s (strike 1)`, { agentId });

  scheduleNextAttempt(agentId, agentName, strike, startedAt, waitSeconds, lastMessageContent, false);
}

function scheduleNextAttempt(
  agentId: string,
  agentName: string,
  strike: number,
  startedAt: number,
  waitSeconds: number,
  lastMessageContent: string | null,
  alerted: boolean,
): void {
  const timer = setTimeout(async () => {
    logger.info(`Rate limit retry firing for ${agentName} (strike ${strike + 1})`, { agentId, strike });

    try {
      // Try replaying the last message
      if (lastMessageContent) {
        const { getAgentRuntime } = await import('./runtime.js');
        const runtime = getAgentRuntime();
        await runtime.handleMessage(agentId, lastMessageContent);
      }

      // Success — clean up and notify agent
      const downtime = formatDuration(Math.round((Date.now() - startedAt) / 1000));
      cleanupRetry(agentId);

      // Only notify the agent if they were in the alerted state (strike 3+)
      if (alerted) {
        // Restore agent status
        try {
          const db = getDb();
          db.prepare("UPDATE agents SET status = 'idle', updated_at = datetime('now') WHERE id = ?").run(agentId);
          broadcast({ type: 'agent:status', agentId, status: 'idle' });
        } catch { /* best effort */ }

        // Tell the agent they're back online
        const isPrimary = isPrimaryAgent(agentId);
        const noticeContent = isPrimary
          ? `[System] You were rate-limited by the API for ${downtime}. You're back online now. Pick up where you left off.`
          : `[System] You were rate-limited by the API for ${downtime}. You're back online now. Let the primary agent know you were temporarily unavailable, then resume your task.`;

        const db = getDb();
        const noticeMsgId = uuidv4();
        db.prepare("INSERT INTO messages (id, agent_id, role, content, created_at) VALUES (?, ?, 'user', ?, datetime('now'))").run(noticeMsgId, agentId, noticeContent);
        broadcast({
          type: 'chat:message',
          agentId,
          message: { id: noticeMsgId, agentId, role: 'user' as const, content: noticeContent, tokenCount: null, modelId: null, cost: null, latencyMs: null, createdAt: new Date().toISOString() },
        });
      } else {
        logger.info(`Transient rate limit resolved silently for ${agentName} after ${downtime}`, { agentId, strike });
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const isStillLimited = msg.includes('rate_limit') || msg.includes('429') || msg.includes('overloaded') || msg.includes('529');

      if (!isStillLimited) {
        // Different error — not a rate limit anymore, let normal error handling take over
        logger.error('Rate limit retry got non-rate-limit error', { agentId, error: msg });
        cleanupRetry(agentId);
        return;
      }

      // Still rate-limited — advance to next strike
      const nextStrike = strike + 1;
      const elapsedMs = Date.now() - startedAt;
      const elapsedHours = elapsedMs / (1000 * 60 * 60);

      // Strike 1 failed → try strike 2 (still silent)
      if (nextStrike < SILENT_RETRIES.length) {
        const nextWait = SILENT_RETRIES[nextStrike];
        logger.info(`Still rate-limited, silent retry ${nextStrike + 1} in ${nextWait}s`, { agentId });
        cleanupRetry(agentId);
        scheduleNextAttempt(agentId, agentName, nextStrike, startedAt, nextWait, lastMessageContent, false);
        return;
      }

      // Strike 3+ — this is real. Alert the owner (once) and start decay schedule.
      const decayIndex = nextStrike - SILENT_RETRIES.length;

      if (decayIndex >= DECAY_SCHEDULE_SECONDS.length || elapsedHours >= 5) {
        // Exhausted the entire schedule
        sendAlert(
          `${agentName} has been rate-limited for ${formatDuration(Math.round(elapsedMs / 1000))}. The window should have reset by now. Check your API account.`,
          'critical',
        );
        logger.error('Rate limit retry fully exhausted', { agentId, elapsedHours: elapsedHours.toFixed(1) });
        cleanupRetry(agentId);
        return;
      }

      // First time hitting strike 3 — alert the owner and set status
      let nowAlerted = alerted;
      if (!alerted) {
        notifyRateLimitHit(agentId, 'rate_limit');

        try {
          const db = getDb();
          db.prepare("UPDATE agents SET status = 'rate_limited', updated_at = datetime('now') WHERE id = ?").run(agentId);
          broadcast({ type: 'agent:status', agentId, status: 'rate_limited' });
        } catch { /* best effort */ }

        nowAlerted = true;
      }

      const nextWait = DECAY_SCHEDULE_SECONDS[decayIndex];
      logger.warn(`Rate limit confirmed for ${agentName}, next retry in ${formatDuration(nextWait)}`, { agentId, decayIndex, strike: nextStrike });
      cleanupRetry(agentId);
      scheduleNextAttempt(agentId, agentName, nextStrike, startedAt, nextWait, lastMessageContent, nowAlerted);
    }
  }, waitSeconds * 1000);

  retryStates.set(agentId, { agentId, timer, strike, startedAt, lastMessageContent, alerted });
}

/**
 * Cancel any pending rate-limit retry for an agent.
 */
export function cancelRateLimitRetry(agentId: string): void {
  cleanupRetry(agentId);
}

/**
 * Check if an agent is currently in rate-limit retry mode.
 */
export function isInRateLimitRetry(agentId: string): boolean {
  return retryStates.has(agentId);
}

// ── Helpers ──

function cleanupRetry(agentId: string): void {
  const state = retryStates.get(agentId);
  if (state?.timer) clearTimeout(state.timer);
  retryStates.delete(agentId);
}

function getAgentName(agentId: string): string {
  try {
    const db = getDb();
    const row = db.prepare('SELECT name FROM agents WHERE id = ?').get(agentId) as { name: string } | undefined;
    return row?.name ?? agentId;
  } catch {
    return agentId;
  }
}

function formatDuration(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.round(seconds / 60)}m`;
  const hours = Math.floor(seconds / 3600);
  const mins = Math.round((seconds % 3600) / 60);
  return mins > 0 ? `${hours}h ${mins}m` : `${hours}h`;
}
