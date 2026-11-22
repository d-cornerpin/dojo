// Start-ack timer: the person who sent a fresh ask is acked after `ENGINE_START_ACK_AFTER_MS` if nothing
// was heard. A timer, since the first model round alone can outlast any loop-boundary check.

import type { Database } from 'better-sqlite3';
import { createLogger } from '../../../../logger.js';
import type { TurnCounterparty, WaitingConversation } from '../../counterparty.js';
import type { TurnContext } from '../../../turn-context.js';
import type { PreflightContext } from './index.js';
import { personShownALineThisTurn } from '../../person-shown-this-turn.js';

const logger = createLogger('v2-loop');

export interface StartAckInputs {
  readonly db: Database;
  readonly counterparty: TurnCounterparty;
  readonly triggerRow: WaitingConversation['latest'];
  readonly turnNumber: number;
}

/** Handed on; the timer handle itself lives on the bag, where teardown reads and clears it. */
export interface StartAckOutputs {
  readonly counterpartyIsAgentSender: boolean;
  readonly startAckArmed: boolean;
  readonly startAckArmedAtMs: number;
  readonly startAckRepliedNow: () => boolean;
  readonly fireStartAckIfOwed: (via: 'timer' | 'first-tool') => Promise<void>;
}

export function runStartAck(
  turnCtx: TurnContext,
  ctx: PreflightContext,
  input: StartAckInputs,
): StartAckOutputs {
  const { agentId, engineStartAckAfterMs } = ctx;
  const { db, counterparty, triggerRow, turnNumber } = input;
  const ENGINE_START_ACK_AFTER_MS = engineStartAckAfterMs;
  // Armed only when the turn serves a waiting human now (`triggerRow` set), never toward an agent sender
  // on a human channel (each ack would wake the peer box). The timer speaks only once tools have started,
  // and a later first tool fires the same routine. The handle and first-tool latch live on the bag.
  const counterpartyIsAgentSender = counterparty.kind === 'user' && !!counterparty.senderIsAgent;
  // "Heard" is per ask: not armed when a visible assistant line landed on an earlier turn after the ask.
  const askAlreadyHeard = (): boolean => {
    try {
      return !!triggerRow && !!db.prepare(
        `SELECT 1 FROM messages WHERE agent_id = ? AND role = 'assistant' AND lane = 'owner' AND seq > ?
           AND turn_number < ? AND (conversation_id IS NULL OR ? IS NULL OR conversation_id = ?)
           AND content NOT LIKE '[{%' AND length(trim(content)) > 0 LIMIT 1`,
      ).get(agentId, triggerRow.rowid, turnNumber, triggerRow.conversation_id, triggerRow.conversation_id);
    } catch { return false; }   // an unreadable probe must not silence a fresh ask
  };
  const startAckArmed = counterparty.kind === 'user' && !!triggerRow && !counterpartyIsAgentSender
    && !askAlreadyHeard();
  const startAckArmedAtMs = Date.now();
  // Heard once a visible assistant row landed this turn or a channel send tool delivered (no text row);
  // `state` is read at fire time, so it sees sends made during the loop.
  const startAckRepliedNow = (): boolean =>
    Object.values(turnCtx.state!.explicitSendThisTurn).some(Boolean) ||
    !!db.prepare(`
    SELECT 1 FROM messages
    WHERE agent_id = ? AND role = 'assistant' AND turn_number = ?
      AND content NOT LIKE '[{%'
      AND origin_intent IS NULL
      AND length(trim(content)) > 0
    LIMIT 1
  `).get(agentId, turnNumber);
  const fireStartAckIfOwed = async (via: 'timer' | 'first-tool'): Promise<void> => {
    try {
      if (!startAckArmed || turnCtx.inboundClassifiedAsWork === false) return;   // a message judged not work gets no start line
      if (turnCtx.engineStartAckDeliveredThisTurn || turnCtx.startAckSteerRequested || turnCtx.startAckSteerArmedThisTurn || startAckRepliedNow()) return;
      // A working note shown, or the delivered start line, counts as heard.
      if (personShownALineThisTurn(agentId, turnNumber)) return;
      // The engine never speaks the ack: it requests a steer that the loop injects at the next iteration
      // boundary, where startAckRepliedNow is re-checked, and the model says the start line.
      turnCtx.startAckSteerRequested = true;
      logger.info('v2 F10: start-ack threshold passed with nothing heard; steer requested so the model says it (engine detects, agent speaks)', {
        agentId, turnNumber, via, thresholdMs: ENGINE_START_ACK_AFTER_MS,
      }, agentId);
    } catch (err) {
      logger.warn('v2 F10: start-ack fire failed (non-fatal)', {
        agentId, error: err instanceof Error ? err.message : String(err),
      }, agentId);
    }
  };
  if (startAckArmed) {
    turnCtx.startAckTimer = setTimeout(() => {
      if (!turnCtx.anyToolStartedThisTurn) {
        // Chat-shaped so far: stay quiet; the delivered flag stays unset so the first-tool hook can speak.
        logger.info('v2 F10: start-ack threshold passed with no tool activity; staying quiet (chat-shaped turn)', {
          agentId, turnNumber,
        }, agentId);
        return;
      }
      void fireStartAckIfOwed('timer');
    }, ENGINE_START_ACK_AFTER_MS);
  }

  return {
    counterpartyIsAgentSender, startAckArmed, startAckArmedAtMs,
    startAckRepliedNow, fireStartAckIfOwed,
  };
}
