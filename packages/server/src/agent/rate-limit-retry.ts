// ════════════════════════════════════════
// Rate Limit Retry Manager
// Handles automatic retries when API rate limits or overloaded errors are hit.
// Strategy depends on whether we have a retry-after header:
//   - With header: wait the exact time, then retry
//   - Without header (OAuth): decaying schedule: 1m, 5m, 30m, 1h, 2h, 3h, 4h, 5h
//   - After 5h with no success: alert owner that something else may be wrong
// ════════════════════════════════════════

import { v4 as uuidv4 } from 'uuid';
import { createLogger } from '../logger.js';
import { broadcast } from '../gateway/ws.js';
import { sendAlert } from '../services/imessage-bridge.js';
import { getDb } from '../db/connection.js';
import { isPrimaryAgent } from '../config/platform.js';

const logger = createLogger('rate-limit-retry');

// Decaying retry schedule (in seconds) for when we don't have a retry-after header
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

// Track active retry states per agent
const retryStates = new Map<string, {
  agentId: string;
  timer: ReturnType<typeof setTimeout>;
  attempt: number;
  startedAt: number;
  lastMessageContent: string | null;
}>();

/**
 * Schedule a rate-limit retry for an agent.
 * Call this when a model call fails with a rate limit or overloaded error.
 *
 * @param agentId The agent that was rate-limited
 * @param retryAfterSeconds Exact seconds to wait (from retry-after header), or null for decay schedule
 * @param lastMessageContent The last user message content to replay when retrying
 */
export function scheduleRateLimitRetry(
  agentId: string,
  retryAfterSeconds: number | null,
  lastMessageContent: string | null,
): void {
  // If already retrying this agent, advance to next attempt in decay schedule
  const existing = retryStates.get(agentId);
  const attempt = existing ? existing.attempt + 1 : 0;

  // If we've exhausted the decay schedule, alert the owner
  if (!retryAfterSeconds && attempt >= DECAY_SCHEDULE_SECONDS.length) {
    const agentName = getAgentName(agentId);
    sendAlert(
      `${agentName} has been rate-limited for over 5 hours. The rate limit window should have reset by now. Something else may be wrong. Check the dashboard or your API account.`,
      'critical',
    );
    logger.error('Rate limit retry exhausted after full decay schedule', { agentId, attempt });
    cleanupRetry(agentId);
    return;
  }

  // Determine wait time
  let waitSeconds: number;
  if (retryAfterSeconds !== null && retryAfterSeconds > 0) {
    waitSeconds = retryAfterSeconds;
  } else {
    waitSeconds = DECAY_SCHEDULE_SECONDS[Math.min(attempt, DECAY_SCHEDULE_SECONDS.length - 1)];
  }

  // Clear any existing timer
  if (existing?.timer) clearTimeout(existing.timer);

  const agentName = getAgentName(agentId);

  // Log and notify
  const waitStr = formatDuration(waitSeconds);
  logger.info(`Scheduling rate-limit retry for ${agentName}`, {
    agentId,
    attempt,
    waitSeconds,
    waitStr,
    hasRetryAfter: retryAfterSeconds !== null,
  });

  // Notify dashboard
  broadcast({
    type: 'agent:rate_limited',
    agentId,
    data: { attempt, waitSeconds, nextRetryAt: new Date(Date.now() + waitSeconds * 1000).toISOString() },
  } as never);

  // Set the agent status to indicate it's waiting
  try {
    const db = getDb();
    db.prepare(`
      UPDATE agents SET status = 'rate_limited', updated_at = datetime('now') WHERE id = ?
    `).run(agentId);
    broadcast({ type: 'agent:status', agentId, status: 'rate_limited' });
  } catch { /* best effort */ }

  // Schedule the retry
  const timer = setTimeout(async () => {
    logger.info(`Rate-limit retry firing for ${agentName}`, { agentId, attempt });

    try {
      // Set agent back to working
      const db = getDb();
      db.prepare(`
        UPDATE agents SET status = 'idle', updated_at = datetime('now') WHERE id = ?
      `).run(agentId);
      broadcast({ type: 'agent:status', agentId, status: 'idle' });

      // Calculate how long the agent was rate-limited
      const state = retryStates.get(agentId);
      const downtime = state ? formatDuration(Math.round((Date.now() - state.startedAt) / 1000)) : 'a while';

      // Inject a system message letting the agent know they were rate-limited
      const isPrimary = isPrimaryAgent(agentId);
      const noticeContent = isPrimary
        ? `[System] You were rate-limited by the API for ${downtime}. You're back online now. If you were in the middle of something, pick up where you left off.`
        : `[System] You were rate-limited by the API for ${downtime}. You're back online now. Let the primary agent know you were temporarily unavailable, then resume your task.`;

      const noticeMsgId = uuidv4();
      db.prepare(`
        INSERT INTO messages (id, agent_id, role, content, created_at)
        VALUES (?, ?, 'user', ?, datetime('now'))
      `).run(noticeMsgId, agentId, noticeContent);

      broadcast({
        type: 'chat:message',
        agentId,
        message: {
          id: noticeMsgId,
          agentId,
          role: 'user' as const,
          content: noticeContent,
          tokenCount: null,
          modelId: null,
          cost: null,
          latencyMs: null,
          createdAt: new Date().toISOString(),
        },
      });

      // Trigger the agent with the notice (which also includes context to resume)
      const { getAgentRuntime } = await import('./runtime.js');
      const runtime = getAgentRuntime();
      await runtime.handleMessage(agentId, noticeContent);

      // If we get here without error, the retry worked — clean up
      cleanupRetry(agentId);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const isStillRateLimited = msg.includes('rate_limit') || msg.includes('429') || msg.includes('overloaded') || msg.includes('529');

      if (isStillRateLimited) {
        // Still rate-limited, schedule next attempt
        logger.warn(`Rate-limit retry failed, still limited. Scheduling next attempt.`, { agentId, attempt });
        scheduleRateLimitRetry(agentId, null, lastMessageContent);
      } else {
        // Different error — clean up and let normal error handling take over
        logger.error(`Rate-limit retry failed with non-rate-limit error`, { agentId, error: msg });
        cleanupRetry(agentId);
      }
    }
  }, waitSeconds * 1000);

  retryStates.set(agentId, {
    agentId,
    timer,
    attempt,
    startedAt: existing?.startedAt ?? Date.now(),
    lastMessageContent,
  });
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
