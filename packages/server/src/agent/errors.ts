import { getDb } from '../db/connection.js';
import { createLogger } from '../logger.js';
import { broadcast } from '../gateway/ws.js';
import { sendAlert } from '../services/imessage-bridge.js';
import { isPrimaryAgent } from '../config/platform.js';
import type { ProviderErrorFacts } from './provider-error.js';
import { writeAgentStatus } from './agent-status.js';
import {
  recordErrorInWindow, noteErrorLoopPause, clearErrorLoop, ERROR_LOOP_WINDOW_MS,
} from './error-loop-state.js';
import { pausedWords, closePausedCards } from './agent-owner-cards.js';

const logger = createLogger('agent-errors');

// Track rate limit notifications per-agent so we don't spam iMessage
// but also don't miss alerts for different agents
const lastRateLimitAlerts = new Map<string, number>();
const RATE_LIMIT_ALERT_COOLDOWN_MS = 5 * 60 * 1000; // 5 minutes between alerts per agent

// ── Custom Error Class ──

export class AgentError extends Error {
  public readonly agentId: string;
  public readonly retryable: boolean;
  public readonly code: string;
  /**
   * PHASE-4 T5 — what the PROVIDER said, carried instead of re-derived.
   *
   * Every consumer downstream of a failed model call used to re-read this error's PROSE for
   * digits (`msg.includes('429')`) because the status code died at the throw site. The facts
   * ride the error now: the status, the provider's own error type, the transport code, and
   * which of those the verdict came from. Present only on errors raised by the model layer.
   */
  public readonly provider: ProviderErrorFacts | null;
  /**
   * T81b — set ONLY by `agent/model.ts`'s pre-dial doomed-request gate, never by a watchdog
   * abort. Both throw the identical `code` (`declared_patience_exceeded`, T81a) — the brief's
   * own instruction is "do not invent a second code" — so `v2/recovery.ts` needs a SEPARATE
   * fact to tell "refused before a byte went out" (free to retry: a forced compaction and a
   * fresh estimate cost nothing a dial did not already cost) apart from "a real dial died at
   * this same declared bound" (a cold re-dial would repeat the exact wall-clock cost that just
   * failed — the one thing P3 forbids). A structured field rather than a second message
   * substring check on purpose: this file's own module header quotes the defect a prose-keyed
   * decision caused elsewhere in this codebase (`provider-error.ts`), and a decision that
   * chooses whether to spend a compaction and a retry is exactly load-bearing enough to earn
   * the same discipline. The refusal's message ALSO carries a distinguishing phrase
   * (`agent/model.ts`'s `PRE_DIAL_REFUSAL_PHRASE`) for a human reading `agents.last_error`
   * after this field itself has not survived a process boundary — the same belt-and-suspenders
   * T81a keeps for its own code/phrase pair.
   */
  public readonly preDialRefusal: boolean;

  constructor(
    message: string,
    agentId: string,
    options?: {
      retryable?: boolean; code?: string; cause?: Error; provider?: ProviderErrorFacts | null;
      preDialRefusal?: boolean;
    },
  ) {
    super(message);
    this.name = 'AgentError';
    this.agentId = agentId;
    this.retryable = options?.retryable ?? false;
    this.code = options?.code ?? 'AGENT_ERROR';
    this.provider = options?.provider ?? null;
    this.preDialRefusal = options?.preDialRefusal ?? false;
    if (options?.cause) {
      this.cause = options.cause;
    }
  }
}

// ── Error Loop Detection ──
//
// PHASE-6 T10 Step 2: the window and the trip decision MOVED to `agent/error-loop-state.ts`,
// backed by `error_loop_state` (migration 157). They were a module-scope Map, so an error
// loop that took the server down reset the counter that exists to stop it, and the five
// records justifying a pause were deleted at the moment they became worth reading. The
// semantics are unchanged — prune the window, record, compare against 5, clear on a trip —
// and the trip now leaves a durable row saying how many errors, over what window, since when.

export function recordError(agentId: string): boolean {
  const now = Date.now();
  const window = recordErrorInWindow(agentId, now);

  if (window.tripped) {
    logger.error('Error loop detected, pausing agent', {
      agentId,
      errorCount: window.count,
      windowMs: ERROR_LOOP_WINDOW_MS,
    }, agentId);

    pauseAgent(agentId);
    // Reset after pausing — and KEEP the decision. The window is emptied; one durable row
    // records what it was emptied for.
    noteErrorLoopPause(agentId, window, now);

    // A paused agent is a BROKEN agent: one of the two things the owner ruled the platform may
    // tell him directly (OR-V333-SET (3)); once per trip, as the window empties on the trip.
    // The owner first, then the agent's own chat in the SAME words, so on that chat the two
    // fold into one card (t138 round 3). v2.3.19: plain language, the count stays in logs.
    const words = pausedWords(agentId);
    sendAlert(words, 'notice');
    broadcast({ type: 'chat:error', agentId, error: words, code: 'ERROR_LOOP', severity: 'error', retryable: false });

    return true; // Signal: agent was paused
  }

  return false;
}

export function clearErrors(agentId: string): void {
  clearErrorLoop(agentId);
  closePausedCards(agentId); // a clean turn: the agent works again, so the owner's card for the trip ends
}

/**
 * Notify the owner via iMessage when a rate limit or overloaded error is hit.
 * Throttled to one alert per 5 minutes to avoid spam.
 */
export function notifyRateLimitHit(agentId: string, errorType: 'rate_limit' | 'overloaded'): void {
  const now = Date.now();
  const lastAlert = lastRateLimitAlerts.get(agentId) ?? 0;
  if (now - lastAlert < RATE_LIMIT_ALERT_COOLDOWN_MS) return;
  lastRateLimitAlerts.set(agentId, now);

  try {
    const db = getDb();
    const agent = db.prepare('SELECT name FROM agents WHERE id = ?').get(agentId) as { name: string } | undefined;
    const name = agent?.name ?? agentId;
    const msg = errorType === 'rate_limit'
      ? `${name} hit an API rate limit. Requests are being throttled. The agent will retry automatically.`
      : `${name} got an API overloaded error. Anthropic's servers are at capacity. The agent will retry automatically.`;
    sendAlert(msg, 'warning'); // R-V333-4: 'will retry' is no blocker; the dashboard shows it
  } catch (err) {
    logger.warn('Failed to send rate limit iMessage alert', { agentId, error: err instanceof Error ? err.message : String(err) });
  }
}

function pauseAgent(agentId: string): void {
  try {
    // PHASE-6 T10: through the ONE status writer. Same columns, same values; the broadcast
    // stays here because this site's own event carries no turn facts.
    writeAgentStatus(agentId, 'paused');

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
//
// T81a — `withRetry` (generic exponential-backoff retry helper, `maxRetries=3, baseDelayMs=
// 1000, maxDelayMs=30000`) DELETED here. Census (NO-DOOMED-DIALS, row 9) named it a dead
// mechanism; re-verified at this task's own HEAD before deleting (`grep -rn withRetry` across
// the whole monorepo, excluding `dist/`): the ONLY match left in the entire tree was this
// function's own definition. It had zero live callers and — contrary to the census's note that
// it once had "its own test" — no dedicated test file exists for it in this tree today; there
// is no test to tombstone because none was found. A flat-arbitrary-backoff retry helper sitting
// unused was a liability in its own right: exactly the shape someone could wire up later, on a
// model call, without having read P2/P3 (a bound must be declared or derived, never a flat
// constant; a tripped bound fails honestly to a human, it never silently re-dials).
