import { getDb } from '../db/connection.js';
import { createLogger } from '../logger.js';
import { broadcast } from '../gateway/ws.js';

const logger = createLogger('agent-errors');

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
    return true; // Signal: agent was paused
  }

  return false;
}

export function clearErrors(agentId: string): void {
  agentErrors.delete(agentId);
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
