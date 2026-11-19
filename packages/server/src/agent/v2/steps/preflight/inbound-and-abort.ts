// Resolves the turn's inbound channel and builds the abort revert: it marks the turn for the hand-back at
// finalize, and releases an engine event the turn claimed.

import { resolveInbound, type InboundChannel } from '../../inbound-channel.js';
import { findUnrepliedAssignForAgent, type UnrepliedAssign } from '../../../a2a-replies.js';
import { releaseEngineEventByRowid } from '../../../../memory/message-store.js';
import { recordEngineEventDeliveryFailure, type WaitingConversation } from '../../counterparty.js';
import type { ChannelInboundContext } from '../../state.js';
import type { TurnContext } from '../../../turn-context.js';
import type { PreflightContext, PreflightScratch } from './index.js';

export interface InboundAndAbortInputs {
  readonly triggerRow: WaitingConversation['latest'];
  readonly lastUserMessageContent: string;
}

export interface InboundAndAbortOutputs {
  readonly revertTriggerStampOnAbort: () => void;
  readonly triggeredByIMessage: boolean;
  readonly inboundChannel: InboundChannel;
  readonly inboundContext: ChannelInboundContext | null;
  readonly unrepliedAssign: UnrepliedAssign | null;
}

export function runInboundAndAbort(
  turnCtx: TurnContext,
  ctx: PreflightContext,
  sc: PreflightScratch,
  input: InboundAndAbortInputs,
): InboundAndAbortOutputs {
  const { agentId } = ctx;
  const { triggerRow, lastUserMessageContent } = input;
  // A no-answer abort: the ask is handed back at finalize by the turn's exit (`handBackAsk`). An engine
  // trigger releases its own claim here, and records the failed delivery, only when the turn made no side effect.
  const revertTriggerStampOnAbort = () => {
    turnCtx.abortHandBack = true;
    if (sc.claimedEngineEvent != null) {
      try {
        if (turnCtx.state!.nonIdempotentCallsThisTurn === 0) {
          const reverted = releaseEngineEventByRowid({
            rowid: sc.claimedEngineEvent.rowid, agentId, turnNumber: sc.claimedEngineEvent.turnNumber,
          });
          if (reverted > 0) recordEngineEventDeliveryFailure(agentId, sc.claimedEngineEvent.rowid);
        }
      } catch { /* best effort, recovery, never block the abort */ }
    }
  };
  const triggeredByIMessage = lastUserMessageContent?.includes('[SOURCE: IMESSAGE FROM') ?? false;
  // One resolver for the inbound channel and reply context; the reply-destination resolver reads them.
  const resolvedInbound = resolveInbound({
    agentId,
    content: lastUserMessageContent,
    channel: triggerRow?.channel ?? null,
    inboundMeta: triggerRow?.inbound_meta ?? null,
  });
  const inboundChannel = resolvedInbound.inboundChannel;
  const inboundContext = resolvedInbound.inboundContext;
  // A live phone call streams sentence chunks to TTS while the model is still generating.
  if (inboundChannel === 'phone' && inboundContext?.phoneCallSid) {
    turnCtx.phoneStreamCallSid = inboundContext.phoneCallSid;
  }
  // Null once the latest ASSIGN/QUESTION/BLOCK was replied to (durable a2a_replies), so the enforcer
  // never fires twice for an inbound already handled.
  const unrepliedAssign = findUnrepliedAssignForAgent(agentId);

  return {
    revertTriggerStampOnAbort, triggeredByIMessage,
    inboundChannel, inboundContext, unrepliedAssign,
  };
}
