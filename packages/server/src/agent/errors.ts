import { getDb } from '../db/connection.js';
import { createLogger } from '../logger.js';
import { broadcast } from '../gateway/ws.js';
import { sendAlert } from '../services/imessage-bridge.js';
import type { ProviderErrorFacts } from './provider-error.js';
import { writeAgentStatus } from './agent-status.js';
import {
  recordErrorInWindow, noteErrorLoopPause, clearErrorLoop, ERROR_LOOP_WINDOW_MS,
} from './error-loop-state.js';
import { pausedWords, closePausedCards, endNotice } from './agent-owner-cards.js';
import { ownerConditionsOnHealthyWork, tellOwner } from '../healer/owner-notices.js';
export { pausedWords };

const logger = createLogger('agent-errors');

export class AgentError extends Error {
  public readonly agentId: string;
  public readonly retryable: boolean;
  public readonly code: string;
  /** What the PROVIDER said, carried on the error so no consumer re-reads its prose for digits.
   *  Present only on errors raised by the model layer. */
  public readonly provider: ProviderErrorFacts | null;
  /** Set ONLY by `agent/model.ts`'s pre-dial gate, never by a watchdog abort. Both throw the
   *  same code (`declared_patience_exceeded`), so recovery reads THIS field to tell a refusal
   *  before a byte went out (free to retry) from a real dial that died at the declared bound
   *  (a cold re-dial would repeat the wall-clock cost that just failed). Structured, never a
   *  message substring check; the refusal's message carries `PRE_DIAL_REFUSAL_PHRASE` too. */
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
    // Reset after pausing, and keep the decision: one durable row records what it was emptied for.
    noteErrorLoopPause(agentId, window, now);

    // A paused agent is a broken agent, so it earns a direct notice to the owner, once per trip,
    // as the window empties. The owner first, then the agent's chat in the SAME words, so on
    // that chat the two notices fold into one card.
    const words = pausedWords(agentId);
    tellOwner(`paused:${agentId}`, words);
    void sendAlert(words, 'notice', { kind: 'broken-agent', agentId });
    broadcast({ type: 'chat:error', agentId, error: words, code: 'ERROR_LOOP', severity: 'error', cardClass: 'action', retryable: false });   // paused until he acts

    return true;
  }

  return false;
}

export function clearErrors(agentId: string): void {
  clearErrorLoop(agentId);
  closePausedCards(agentId); // a clean turn: the agent works again, so the owner's card for the trip ends
  endNotice(agentId, 'broken_notice'); // and a BROKEN incident is over: the next one is told again
  ownerConditionsOnHealthyWork(agentId); // and if it is the Healer, "Healer broken" ends
}

function pauseAgent(agentId: string): void {
  try {
    // Through the ONE status writer; the broadcast stays here because this event carries no turn facts.
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

