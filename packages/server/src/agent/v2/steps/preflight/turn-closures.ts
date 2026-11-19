// The turn's closures handed to later steps: the stranded-ask re-arm, the continuation stash, the two
// row writers, the answer-key setter, the per-turn registers and the engine ack. Functions, not values,
// because they read the turn's state live from the bag.

import { v4 as uuidv4 } from 'uuid';
import type { DisplayKind } from '@dojo/shared';
import { broadcast } from '../../../../gateway/ws.js';
import { createLogger } from '../../../../logger.js';
import { insertMessageIfAbsent, START_ACK_ORIGIN_INTENT } from '../../../../memory/message-store.js';
import { resolveRecipientDisplay } from '../../../../contacts/resolve-recipient.js';
import { continuationContext } from '../../../turn-state.js';
import type { TurnContext } from '../../../turn-context.js';
import { engineAckReachesTheirChannel, type TurnCounterparty } from '../../counterparty.js';
import { withOutboundAsync } from '../../outbound.js';
import { replyAddressFor, writeRoutingPill } from '../../channel-sender.js';
import { queueReply } from '../../deliveries.js';
import { engineMayRouteTo } from '../../../access/engine-route.js';
import type { PreflightContext, PreflightScratch } from './index.js';

const logger = createLogger('v2-loop');

export interface TurnClosuresInputs {
  readonly counterparty: TurnCounterparty;
  readonly chosenConvKey: string;
  readonly chosenConversationId: string | null;
  readonly turnNumber: number;
  readonly revertTriggerStampOnAbort: () => void;
}

export interface TurnClosuresOutputs {
  readonly reArmIfStrandedNoAnswer: () => void;
  readonly stashContinuationIfHuman: () => void;
  readonly persistRoutingMarker: (label: string) => void;
  readonly persistAndBroadcastSystemRow: (content: string) => string;
  readonly noteTerminalAnswer: (rowId: string, surface: string) => void;
  readonly refusedOnceSigs: Set<string>;
  readonly deliverEngineUserAck: (
    text: string, originIntent?: string | null, reuseId?: string | null, displayKind?: DisplayKind | null,
  ) => Promise<void>;
}

export function runTurnClosures(
  turnCtx: TurnContext,
  ctx: PreflightContext,
  sc: PreflightScratch,
  input: TurnClosuresInputs,
): TurnClosuresOutputs {
  const { agentId } = ctx;
  const { counterparty, chosenConvKey, chosenConversationId, turnNumber, revertTriggerStampOnAbort } = input;
  // Re-arms a stranded human ask only on a clean retry: no user-facing text, no surfaced reply, no channel
  // send, and no non-idempotent call (re-serving after a side effect would duplicate it). On an engine
  // turn the same revert releases the engine-event claim.
  const reArmIfStrandedNoAnswer = () => {
    if (
      !turnCtx.state!.lastAssistantTextForIM &&
      !turnCtx.state!.surfacedReplyThisTurn &&
      !Object.values(turnCtx.state!.explicitSendThisTurn).some(Boolean) &&
      turnCtx.state!.nonIdempotentCallsThisTurn === 0
    ) {
      revertTriggerStampOnAbort();
    }
  };

  // Before an engine auto-continue, stash the human conversation this turn serves: the continuation fires
  // with an empty trigger and restores it, so the answer reaches the right person and channel.
  const stashContinuationIfHuman = () => {
    if (chosenConvKey) continuationContext.set(agentId, { convKey: chosenConvKey, conversationId: chosenConversationId, counterparty, address: turnCtx.address });
  };

  // The dashboard's routing pill for this turn; the deliveries row is written by the send's own door.
  const persistRoutingMarker = (label: string): void => { void writeRoutingPill(agentId, turnNumber, label); };

  // Persists a system row and broadcasts it, so wordy mode shows it live and not only after a refresh.
  const persistAndBroadcastSystemRow = (content: string): string => {
    const rowId = uuidv4();
    insertMessageIfAbsent({ id: rowId, agentId, role: 'system', content, turnNumber });
    broadcast({
      type: 'chat:message',
      agentId,
      message: {
        id: rowId, agentId, role: 'system' as const, content,
        tokenCount: null, modelId: null, cost: null, latencyMs: null,
        createdAt: new Date().toISOString(),
      },
    });
    return rowId;
  };

  /** The one setter of the truthful-answer key; that key alone decides whether the turn answered. */
  const noteTerminalAnswer = (rowId: string, surface: string): void => {
    sc.terminalAnswerRowId = rowId;
    logger.debug('v2: truthful-answer key set', { agentId, rowId, surface }, agentId);
  };
  // Calls refused once this turn (reminder lane, main-agent hurdle); the identical repeat proceeds.
  const refusedOnceSigs = new Set<string>();

  const deliverEngineUserAck = async (
    text: string, originIntent: string | null = null, reuseId: string | null = null,
    displayKind: DisplayKind | null = null,
  ): Promise<void> => {
    // Delivers a model-written line early as an assistant row and pushes it to the counterparty's channel.
    // `reuseId` makes an already-streamed bubble the delivered row; `displayKind` overrides the classifier
    // (null means classify). `originIntent` marks a start-ack structurally; null keeps a substantive reply.
    // origin_kind stays NULL so `deriveOrigin` still reads the row as the agent speaking.
    const ackId = reuseId ?? uuidv4();
    try {
      insertMessageIfAbsent({
        id: ackId, agentId, role: 'assistant', content: text, turnNumber, originIntent,
        ...(displayKind ? { displayKind } : {}),
      });
      broadcast({
        type: 'chat:message',
        agentId,
        message: {
          id: ackId, agentId, role: 'assistant' as const,
          content: text,
          tokenCount: null, modelId: null, cost: null, latencyMs: null,
          createdAt: new Date().toISOString(),
        },
      });
    } catch (err) {
      logger.warn('v2: engine user-ack persist/broadcast failed (non-fatal)', {
        agentId, error: err instanceof Error ? err.message : String(err),
      }, agentId);
    }
    // Queue the line for the person's text channel (a phone call hears it at once), best effort: it stands in chat
    // regardless. A start line is never an answer; an early answer names its row so the turn's end does not resend it.
    try {
      if (counterparty.kind !== 'user') return;
      // One channel guard for every arm: a withheld line costs the channel hop, never the line.
      if (!engineMayRouteTo(agentId, counterparty.channel)) {
        logger.warn('v2: engine user-ack channel push withheld (the sending agent holds no grant on this channel; the ack stands in chat)', {
          agentId, channel: counterparty.channel,
        }, agentId);
        return;
      }
      const inbound = turnCtx.state!.inboundContext;
      if (counterparty.channel === 'phone' && inbound?.phoneCallSid) {
        const { getCallSession } = await import('../../../../twilio/call-session.js');
        const session = getCallSession(inbound.phoneCallSid);
        if (session && !session.isEnded()) {
          await withOutboundAsync(
            {
              agentId, tool: 'engine-ack', channel: 'phone',
              recipientId: inbound.phoneFromNumber ?? counterparty.senderId ?? null,
              conversationId: turnCtx.root?.conversationId ?? null,
            },
            () => session.queueAgentSay(text),
          );
          persistRoutingMarker(`phone call to ${resolveRecipientDisplay('phone', inbound.phoneFromNumber ?? counterparty.senderId ?? '(unknown)')}`);
        }
        return;
      }
      if (!engineAckReachesTheirChannel(counterparty) || !counterparty.senderId) return;
      const address = replyAddressFor({ ...inbound, channel: counterparty.channel, sender: counterparty.senderId });
      if (!address) return;
      const startLine = originIntent === START_ACK_ORIGIN_INTENT;
      const queued = await queueReply({ agentId, turnNumber, root: turnCtx.root ?? null, text, address, kind: startLine ? 'start-line' : 'reply' });
      if (queued && !startLine) turnCtx.earlyAnswerRowId = queued.id;
    } catch (err) {
      logger.warn('v2: engine user-ack channel delivery failed (non-fatal)', {
        agentId, error: err instanceof Error ? err.message : String(err),
      }, agentId);
    }
  };

  return {
    reArmIfStrandedNoAnswer, stashContinuationIfHuman, persistRoutingMarker,
    persistAndBroadcastSystemRow, noteTerminalAnswer,
    refusedOnceSigs, deliverEngineUserAck,
  };
}
