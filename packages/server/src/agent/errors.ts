import { getDb } from '../db/connection.js';
import { createLogger } from '../logger.js';
import { broadcast } from '../gateway/ws.js';
import { sendAlert } from '../services/imessage-bridge.js';
import { isPrimaryAgent } from '../config/platform.js';

const logger = createLogger('agent-errors');

// Track rate limit notifications so we don't spam iMessage
let lastRateLimitAlert = 0;
const RATE_LIMIT_ALERT_COOLDOWN_MS = 5 * 60 * 1000; // 5 minutes between alerts

// ── Custom Error Class ──

export class AgentError extends Error {
  public readonly agentId: string;
  public readonly retryable: boolean;
  public readonly code: string;

  constructor(message: string, agentId: string, options?: { retryable?: boolean; code?: string; cause?: Error }) {
    super(message);
    this.name = 'AgentError';
    this.agentId = agentId;
    this.retryable = options?.retryable ?? false;
    this.code = options?.code ?? 'AGENT_ERROR';
    if (options?.cause) {
      this.cause = options.cause;
    }
  }
}

// ── Error Loop Detection ──

interface ErrorRecord {
  timestamp: number;
}

const agentErrors = new Map<string, ErrorRecord[]>();

const ERROR_LOOP_THRESHOLD = 5;
const ERROR_LOOP_WINDOW_MS = 2 * 60 * 1000; // 2 minutes

export function recordError(agentId: string): boolean {
  const now = Date.now();
  const records = agentErrors.get(agentId) ?? [];

  // Clean old records outside the window
  const recentRecords = records.filter(r => now - r.timestamp < ERROR_LOOP_WINDOW_MS);
  recentRecords.push({ timestamp: now });

  agentErrors.set(agentId, recentRecords);

  if (recentRecords.length >= ERROR_LOOP_THRESHOLD) {
    logger.error('Error loop detected, pausing agent', {
      agentId,
      errorCount: recentRecords.length,
      windowMs: ERROR_LOOP_WINDOW_MS,
    }, agentId);

    pauseAgent(agentId);
    agentErrors.delete(agentId); // Reset after pausing

    // Broadcast structured error to dashboard so the chat shows why the agent was paused
    const errorMsg = `Agent paused: ${ERROR_LOOP_THRESHOLD} errors in ${ERROR_LOOP_WINDOW_MS / 1000} seconds. Check the Health page for details.`;
    broadcast({
      type: 'chat:error',
      agentId,
      error: errorMsg,
      code: 'ERROR_LOOP',
      severity: 'error',
      retryable: false,
    });

    // Notify owner via iMessage
    try {
      const db = getDb();
      const agent = db.prepare('SELECT name FROM agents WHERE id = ?').get(agentId) as { name: string } | undefined;
      const name = agent?.name ?? agentId;
      sendAlert(`${name} has been paused due to repeated errors (${ERROR_LOOP_THRESHOLD} failures in ${ERROR_LOOP_WINDOW_MS / 1000}s). Check the dashboard.`, 'critical');
    } catch { /* best effort */ }

    return true; // Signal: agent was paused
  }

  return false;
}

export function clearErrors(agentId: string): void {
  agentErrors.delete(agentId);
}

/**
 * Notify the owner via iMessage when a rate limit or overloaded error is hit.
 * Throttled to one alert per 5 minutes to avoid spam.
 */
export function notifyRateLimitHit(agentId: string, errorType: 'rate_limit' | 'overloaded'): void {
  const now = Date.now();
  if (now - lastRateLimitAlert < RATE_LIMIT_ALERT_COOLDOWN_MS) return;
  lastRateLimitAlert = now;

  try {
    const db = getDb();
    const agent = db.prepare('SELECT name FROM agents WHERE id = ?').get(agentId) as { name: string } | undefined;
    const name = agent?.name ?? agentId;
    const msg = errorType === 'rate_limit'
      ? `${name} hit an API rate limit. Requests are being throttled. The agent will retry automatically.`
      : `${name} got an API overloaded error. Anthropic's servers are at capacity. The agent will retry automatically.`;
    sendAlert(msg, 'warning');
  } catch { /* best effort */ }
}

function pauseAgent(agentId: string): void {
  try {
    const db = getDb();
    db.prepare(`
      UPDATE agents SET status = 'paused', updated_at = datetime('now') WHERE id = ?
    `).run(agentId);

    broadcast({
      type: 'agent:status',
      agentId,
      status: 'paused',
    });
  } catch (err) {
    logger.error('Failed to pause agent', {
      agentId,
      error: err instanceof Error ? err.message : String(err),
    }, agentId);
  }
}

// ── Retry Logic ──

export interface RetryOptions {
  maxRetries: number;
  baseDelayMs: number;
  maxDelayMs: number;
}

const DEFAULT_RETRY_OPTIONS: RetryOptions = {
  maxRetries: 3,
  baseDelayMs: 1000,
  maxDelayMs: 30000,
};

export async function withRetry<T>(
  fn: () => Promise<T>,
  agentId: string,
  options?: Partial<RetryOptions>,
): Promise<T> {
  const opts = { ...DEFAULT_RETRY_OPTIONS, ...options };
  let lastError: Error | undefined;

  for (let attempt = 0; attempt <= opts.maxRetries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));

      // Don't retry non-retryable errors
      if (err instanceof AgentError && !err.retryable) {
        throw err;
      }

      // Don't inline-retry rate limits — the background retry manager handles those
      if (err instanceof AgentError && err.code === 'MODEL_CALL_FAILED') {
        const msg = err.message.toLowerCase();
        if (msg.includes('rate_limit') || msg.includes('429') || msg.includes('overloaded')) {
          throw err; // Let the background retry handle it
        }
      }

      if (attempt < opts.maxRetries) {
        const delay = Math.min(
          opts.baseDelayMs * Math.pow(2, attempt),
          opts.maxDelayMs,
        );

        logger.warn(`Retrying after error (attempt ${attempt + 1}/${opts.maxRetries}): ${lastError.message}`, {
          attempt: attempt + 1,
          maxRetries: opts.maxRetries,
          delayMs: delay,
        }, agentId);

        await new Promise(resolve => setTimeout(resolve, delay));
      }
    }
  }

  throw lastError ?? new Error('Retry failed with unknown error');
}
