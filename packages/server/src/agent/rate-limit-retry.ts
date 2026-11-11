// Three-strike rate-limit recovery: two silent retries (10s, 30s), then an alert and a
// decay schedule. A retry-after header, when present, overrides every listed wait.

import { v4 as uuidv4 } from 'uuid';
import { createLogger } from '../logger.js';
import { broadcast } from '../gateway/ws.js';
import { sendAlert } from '../services/imessage-bridge.js';
import { getDb } from '../db/connection.js';
import { insertMessageIfAbsent } from '../memory/message-store.js';
import { isPrimaryAgent } from '../config/platform.js';
import { notifyRateLimitHit } from './errors.js';
import { providerClassOf } from './provider-error.js';
import { setAgentStatus, writeAgentStatus } from './agent-status.js';
import { noteRateLimitExhausted } from './agent-owner-cards.js';
import { registerRetryWake, registerTimerWake } from '../work/task-freshness.js';

const logger = createLogger('rate-limit-retry');

const SILENT_RETRIES = [10, 30];

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

/** Handle a rate-limit or overloaded error for an agent; the model layer calls this on 429/529. */
export function scheduleRateLimitRetry(
  agentId: string,
  retryAfterSeconds: number | null,
  lastMessageContent: string | null,
): void {
  if (retryStates.has(agentId)) {
    logger.debug('Rate limit retry already active, ignoring duplicate', { agentId });
    return;
  }

  const strike = 0;
  const startedAt = Date.now();

  const waitSeconds = retryAfterSeconds !== null && retryAfterSeconds > 0
    ? retryAfterSeconds
    : SILENT_RETRIES[0];

  const agentName = getAgentName(agentId);
  logger.info(`Rate limit hit for ${agentName}, silent retry in ${waitSeconds}s (strike 1)`, { agentId });

  scheduleNextAttempt(agentId, agentName, strike, startedAt, waitSeconds, lastMessageContent, false, registerRetryWake(agentId));
}

function scheduleNextAttempt(
  agentId: string,
  agentName: string,
  strike: number,
  startedAt: number,
  waitSeconds: number,
  lastMessageContent: string | null,
  alerted: boolean,
  carried: boolean,   // a carrying run's own wake: the retry restarts the run as the job's continuation
): void {
  if (carried && strike > 0) registerTimerWake(agentId);
  const timer = setTimeout(async () => {
    logger.info(`Rate limit retry firing for ${agentName} (strike ${strike + 1})`, { agentId, strike });

    try {
      if (lastMessageContent) {
        const { getAgentRuntime } = await import('./runtime.js');
        const runtime = getAgentRuntime();
        await runtime.handleMessage(agentId, lastMessageContent, carried ? { job: true } : undefined);
      }

      // Success: clean up and notify the agent
      const downtime = formatDuration(Math.round((Date.now() - startedAt) / 1000));
      cleanupRetry(agentId);

      if (alerted) {
        try {
          writeAgentStatus(agentId, 'idle');
          broadcast({ type: 'agent:status', agentId, status: 'idle' });
        } catch { /* best effort */ }

        // Tell the agent they're back online
        const isPrimary = isPrimaryAgent(agentId);
        const noticeContent = isPrimary
          ? `[SOURCE: SYSTEM — not a message from the user] You were rate-limited by the API for ${downtime}. You're back online now. Pick up where you left off.`
          : `[SOURCE: SYSTEM — not a message from the user] You were rate-limited by the API for ${downtime}. You're back online now. Let the primary agent know you were temporarily unavailable, then resume your task.`;

        const noticeMsgId = uuidv4();
        insertMessageIfAbsent({ id: noticeMsgId, agentId, role: 'user', content: noticeContent });
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
      // Ask the provider's status, not the message's digits.
      const cls = providerClassOf(err);
      const isStillLimited = cls === 'rate_limit' || cls === 'overloaded';   // out of credit is not a wait

      if (!isStillLimited) {
        // Different error: not rate-limited anymore, normal error handling takes over
        logger.error('Rate limit retry got non-rate-limit error', { agentId, error: msg });
        cleanupRetry(agentId);
        return;
      }

      // Still rate-limited: advance to next strike
      const nextStrike = strike + 1;
      const elapsedMs = Date.now() - startedAt;
      const elapsedHours = elapsedMs / (1000 * 60 * 60);

      // Strike 1 failed: try strike 2, still silent
      if (nextStrike < SILENT_RETRIES.length) {
        const nextWait = SILENT_RETRIES[nextStrike];
        logger.info(`Still rate-limited, silent retry ${nextStrike + 1} in ${nextWait}s`, { agentId });
        cleanupRetry(agentId);
        scheduleNextAttempt(agentId, agentName, nextStrike, startedAt, nextWait, lastMessageContent, false, carried);
        return;
      }

      // Strike 3+: this is real, alert the owner once, start the decay schedule
      const decayIndex = nextStrike - SILENT_RETRIES.length;

      if (decayIndex >= DECAY_SCHEDULE_SECONDS.length || elapsedHours >= 5) {
        // Exhausted the entire schedule
        // The words wait on the owner's dashboard until dismissed or the alert gets through.
        const words = `${agentName} has been rate-limited for ${formatDuration(Math.round(elapsedMs / 1000))}. The window should have reset by now. Check your API account.`;
        void sendAlert(noteRateLimitExhausted(agentId, words), 'critical', { kind: 'broken-agent', agentId });
        logger.error('Rate limit retry fully exhausted', { agentId, elapsedHours: elapsedHours.toFixed(1) });
        cleanupRetry(agentId);
        return;
      }

      // First strike 3: alert the owner and set status
      let nowAlerted = alerted;
      if (!alerted) {
        notifyRateLimitHit(agentId, 'rate_limit');

        // The write goes through setAgentStatus, the ONE status writer, which reports its own
        // failures instead of dropping them. The optional hint below keeps its own narrow
        // best-effort catch so it can never decide whether the owner hears about a rate limit.
        setAgentStatus(agentId, 'rate_limited');

        // For auto-routed agents, suggest switching models. Genuinely optional:
        // its own try, so a read failure here costs the hint and nothing else.
        try {
          const agentRow = getDb().prepare('SELECT model_id FROM agents WHERE id = ?').get(agentId) as { model_id: string | null } | undefined;
          if (agentRow?.model_id === 'auto') {
            broadcast({
              type: 'chat:error', cardClass: 'informational',
              agentId,
              error: `Still rate-limited after ${formatDuration(Math.round(elapsedMs / 1000))}. The auto-router will try a different model on the next attempt.`,
              code: 'RATE_LIMITED',
              severity: 'warning',
              retryable: true,
            });
          }
        } catch (hintErr) {
          logger.debug('Auto-router rate-limit hint skipped', {
            agentId, error: hintErr instanceof Error ? hintErr.message : String(hintErr),
          });
        }

        nowAlerted = true;
      }

      const nextWait = DECAY_SCHEDULE_SECONDS[decayIndex];
      logger.warn(`Rate limit confirmed for ${agentName}, next retry in ${formatDuration(nextWait)}`, { agentId, decayIndex, strike: nextStrike });
      cleanupRetry(agentId);
      scheduleNextAttempt(agentId, agentName, nextStrike, startedAt, nextWait, lastMessageContent, nowAlerted, carried);
    }
  }, waitSeconds * 1000);

  retryStates.set(agentId, { agentId, timer, strike, startedAt, lastMessageContent, alerted });
}

/** True when a background decay retry owns this agent's rate-limit recovery: the v2
 *  recovery cascade skips its injury path while one is active, so a 429/529 is not
 *  handled twice. A state exists from arming until cleanupRetry clears it. */
export function hasActiveRateLimitRetry(agentId: string): boolean {
  return retryStates.has(agentId);
}

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

export function formatDuration(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  const totalMinutes = Math.round(seconds / 60);
  const hours = Math.floor(totalMinutes / 60);
  const mins = totalMinutes % 60;
  return hours > 0 ? (mins > 0 ? `${hours}h ${mins}m` : `${hours}h`) : `${totalMinutes}m`;
}
